// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { README_NAMES, renderReadmes } from "../render-readme.mjs";
import { canonicalJson } from "./canonical-json.mjs";
import { assertReleaseCommitShape } from "./release-tag-gate.mjs";

export const RELEASE_ACTIONS = Object.freeze(["tag", "push", "release", "wiki"]);
export const RELEASE_VERSION_SHAPE = /^\d+\.\d+\.\d+$/u;
export const ENGINE_PACKAGE_NAME = "einzbern";
export const HELPER_PACKAGE_NAME = "mana-orchestrate";
export const CHANGELOG_FILE = "CHANGELOG.md";
export const RELEASE_OUTPUT_DIRECTORY = "dist/release";
export const FRAMEWORK_VERSION_SOURCE = "packages/core/src/framework-version.ts";
// The built leaf the release reads the engine version from: the barrel re-exports it, and a module the
// barrel imports keeps its first evaluation in this process, so only the leaf itself can be read again.
const FRAMEWORK_VERSION_BUILT = "dist/build/packages/core/src/framework-version.js";
export const RELEASE_RECEIPT_SCHEMA = "einzbern.release-generate-receipt.v1";
export const RELEASE_NOTE_DIRECTORY = "docs/releases";
const CLI_REFERENCE_FILE = "docs/wiki/CLI-Reference.md";
const FRAMEWORK_VERSION_DECLARATION = /^export const FRAMEWORK_VERSION = "(\d+\.\d+\.\d+)" as const;$/gmu;
const COMMIT_ID_SHAPE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;

const HELPER_README_NAMES = Object.freeze(["README.md", "README.en.md", "README.ja.md", "README.ko.md", "README.fr.md"]);
const RELEASE_ASSET = (version) => `${ENGINE_PACKAGE_NAME}-${version}.tar.gz`;
const RELEASE_SUMMARY = (version) => `Einzbern and Mana Orchestrate ship in lockstep at ${version}.`;

export class ReleaseLockstepError extends Error {
  constructor(reasonCode, message, details = {}) {
    super(message);
    this.name = "ReleaseLockstepError";
    this.reasonCode = reasonCode;
    this.details = details;
  }
}

function refuse(reasonCode, message, details = {}) {
  throw new ReleaseLockstepError(reasonCode, message, details);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asJson(value, path) {
  try {
    const parsed = JSON.parse(value);
    if (!isRecord(parsed)) refuse("RELEASE_MANIFEST_INVALID", `${path} must contain a JSON object`, { path });
    return parsed;
  } catch (error) {
    if (error instanceof ReleaseLockstepError) throw error;
    refuse("RELEASE_MANIFEST_INVALID", `${path} is not valid JSON`, { path, error: String(error?.message ?? error) });
  }
}

async function readJson(path) {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    refuse("RELEASE_FILE_MISSING", `${path} does not exist`, { path, code: error?.code ?? "UNKNOWN" });
  }
  if (!stats.isFile()) refuse("RELEASE_FILE_INVALID", `${path} is not a regular file`, { path });
  return asJson(await readFile(path, "utf8"), path);
}

function versionMismatch(version, path, actual) {
  if (actual !== version) return { path, expected: version, actual: typeof actual === "string" ? actual : null };
  return null;
}

function mismatchError(version, mismatches) {
  if (mismatches.length === 0) return;
  refuse("RELEASE_VERSION_MISMATCH", `release ${version} is not consistent across the engine and helper`, { version, mismatches });
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function changelogSection(changelog, version) {
  const heading = new RegExp(`^## ${escapeRegExp(version)}[ \\t]*$`, "mu");
  const match = heading.exec(changelog);
  if (!match) return null;
  const start = match.index + match[0].length;
  const remainder = changelog.slice(start).replace(/^\r?\n/u, "");
  const next = /^## [^\r\n]+/mu.exec(remainder);
  return next ? remainder.slice(0, next.index).trim() : remainder.trim();
}

function validateChangelog(changelog, version, mismatches) {
  const section = changelogSection(changelog, version);
  if (section === null) {
    mismatches.push({ path: CHANGELOG_FILE, expected: `## ${version} section`, actual: "missing" });
    return;
  }
  // Each release describes its own changes. A historical rename is not a recurring requirement.
  const changes = section.replace(RELEASE_SUMMARY(version), "").trim();
  if (changes.length === 0) {
    mismatches.push({ path: CHANGELOG_FILE, expected: "non-empty notes describing this release", actual: "no release changes" });
  }
}

function skillVersion(content) {
  const match = /^Navigation for Einzbern (\d+\.\d+\.\d+):/mu.exec(content);
  return match?.[1] ?? null;
}

function helperReadmeVersion(content) {
  const match = /https:\/\/img\.shields\.io\/badge\/release-([^?\s]+)-blue/u.exec(content);
  return match?.[1] ?? null;
}

// `raw` keeps stdout as the exact bytes (committed blobs are compared byte for byte); stderr is
// always text.
function run(command, args, { cwd, env = process.env, raw = false } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: raw ? "buffer" : "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  });
  const stdout = result.stdout ?? (raw ? Buffer.alloc(0) : "");
  const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString("utf8") : result.stderr ?? "";
  if (result.error) return { status: 1, stdout, stderr: String(result.error) };
  return { status: result.status ?? 1, stdout, stderr };
}

function git(root, args, env = process.env) {
  const result = run("git", ["-C", root, ...args], { cwd: root, env });
  if (result.status !== 0) {
    refuse("RELEASE_GIT_FAILED", `git ${args.join(" ")} failed in ${root}`, { root, args, stderr: result.stderr.trim() });
  }
  return result.stdout.trim();
}

function gitRaw(root, args, env = process.env) {
  const result = run("git", ["-C", root, ...args], { cwd: root, env, raw: true });
  if (result.status !== 0) {
    refuse("RELEASE_GIT_FAILED", `git ${args.join(" ")} failed in ${root}`, { root, args, stderr: result.stderr.trim() });
  }
  return result.stdout;
}

async function assertRepository(root, expectedName, { clean = false, env = process.env } = {}) {
  const absolute = resolve(root);
  let stats;
  try {
    stats = await lstat(absolute);
  } catch (error) {
    refuse("RELEASE_REPOSITORY_INVALID", `${absolute} does not exist`, { root: absolute, code: error?.code ?? "UNKNOWN" });
  }
  if (!stats.isDirectory()) refuse("RELEASE_REPOSITORY_INVALID", `${absolute} is not a directory`, { root: absolute });
  const top = git(absolute, ["rev-parse", "--show-toplevel"], env);
  if (resolve(top) !== absolute) refuse("RELEASE_REPOSITORY_INVALID", `${absolute} is not the root of a Git working tree`, { root: absolute, gitRoot: top });
  if (clean) {
    const status = git(absolute, ["status", "--porcelain", "--untracked-files=all"], env);
    if (status !== "") refuse("RELEASE_WORKTREE_DIRTY", `${absolute} has uncommitted changes`, { root: absolute, status: status.split("\n") });
  }
  const manifest = await readJson(join(absolute, "package.json"));
  if (manifest.name !== expectedName) {
    refuse("RELEASE_REPOSITORY_INVALID", `${absolute}/package.json is ${String(manifest.name)}, expected ${expectedName}`, { root: absolute, expectedName, actualName: manifest.name ?? null });
  }
  return { root: absolute, manifest };
}

function ensureSeparateRepositories(engineRoot, helperRoot) {
  const common = (left, right) => left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
  if (common(engineRoot, helperRoot)) {
    refuse("RELEASE_REPOSITORIES_OVERLAP", "engine and helper working trees must be separate repositories", { engineRoot, helperRoot });
  }
}

async function enginePackagePaths(engineRoot) {
  const packagesRoot = join(engineRoot, "packages");
  const children = await readdir(packagesRoot, { withFileTypes: true }).catch(() => []);
  const paths = [];
  for (const child of children.filter((entry) => entry.isDirectory()).sort((left, right) => left.name.localeCompare(right.name, "en"))) {
    const manifestPath = join(packagesRoot, child.name, "package.json");
    try {
      await lstat(manifestPath);
      paths.push(manifestPath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return paths;
}

function frameworkVersionDeclaration(source, path) {
  const declarations = [...source.matchAll(FRAMEWORK_VERSION_DECLARATION)];
  if (declarations.length !== 1) refuse("RELEASE_FRAMEWORK_VERSION_INVALID", `${path} must declare exactly one FRAMEWORK_VERSION`, { path });
  return declarations[0];
}

async function builtReleaseModule(engineRoot, path) {
  return import(`${pathToFileURL(join(engineRoot, "dist/build", path)).href}?release=${Date.now()}`);
}

async function releaseFrameworkVersions(engineRoot) {
  const source = await readFile(join(engineRoot, FRAMEWORK_VERSION_SOURCE), "utf8");
  const declaration = frameworkVersionDeclaration(source, FRAMEWORK_VERSION_SOURCE);
  const leaf = await builtReleaseModule(engineRoot, "packages/core/src/framework-version.js");
  return { source, declaration, sourceVersion: declaration[1], builtVersion: leaf.FRAMEWORK_VERSION };
}

export async function checkRelease({ engineRoot, helperRoot, version, env = process.env }) {
  if (typeof version !== "string" || !RELEASE_VERSION_SHAPE.test(version)) {
    refuse("RELEASE_VERSION_INVALID", `${String(version)} is not a stable release version`, { version: String(version) });
  }
  const engine = await assertRepository(engineRoot, ENGINE_PACKAGE_NAME, { env });
  const helper = await assertRepository(helperRoot, HELPER_PACKAGE_NAME, { env });
  ensureSeparateRepositories(engine.root, helper.root);

  const mismatches = [];
  const framework = await releaseFrameworkVersions(engine.root);
  for (const [path, actual] of [[FRAMEWORK_VERSION_SOURCE, framework.sourceVersion], [FRAMEWORK_VERSION_BUILT, framework.builtVersion]]) {
    const mismatch = versionMismatch(version, path, actual);
    if (mismatch) mismatches.push(mismatch);
  }
  const packageFiles = [join(engine.root, "package.json"), ...await enginePackagePaths(engine.root)];
  for (const path of packageFiles) {
    const manifest = await readJson(path);
    const mismatch = versionMismatch(version, path.slice(engine.root.length + 1), manifest.version);
    if (mismatch) mismatches.push(mismatch);
  }
  const helperManifest = await readJson(join(helper.root, "package.json"));
  const helperVersionMismatch = versionMismatch(version, "package.json", helperManifest.version);
  if (helperVersionMismatch) mismatches.push({ ...helperVersionMismatch, repository: "helper" });

  const changelog = await readFile(join(engine.root, CHANGELOG_FILE), "utf8").catch((error) => {
    refuse("RELEASE_FILE_MISSING", `${CHANGELOG_FILE} does not exist`, { path: CHANGELOG_FILE, code: error?.code ?? "UNKNOWN" });
  });
  validateChangelog(changelog, version, mismatches);

  try {
    const readme = await renderReadmes({ root: engine.root, version, check: true });
    if (!readme.ok) mismatches.push({ path: "README*.md", expected: `rendered for ${version}`, actual: readme.drifted });
  } catch (error) {
    if (error instanceof ReleaseLockstepError) throw error;
    mismatches.push({ path: "README*.md", expected: `rendered for ${version}`, actual: String(error?.reasonCode ?? error?.message ?? error) });
  }

  const helperSkill = await readFile(join(helper.root, "skill", HELPER_PACKAGE_NAME, "SKILL.md"), "utf8").catch((error) => {
    refuse("RELEASE_FILE_MISSING", `helper SKILL.md does not exist`, { path: `skill/${HELPER_PACKAGE_NAME}/SKILL.md`, code: error?.code ?? "UNKNOWN" });
  });
  const actualSkillVersion = skillVersion(helperSkill);
  if (actualSkillVersion !== version) {
    mismatches.push({ path: `skill/${HELPER_PACKAGE_NAME}/SKILL.md`, expected: version, actual: actualSkillVersion });
  }
  for (const name of HELPER_README_NAMES) {
    const content = await readFile(join(helper.root, name), "utf8").catch((error) => {
      refuse("RELEASE_FILE_MISSING", `helper ${name} does not exist`, { path: name, code: error?.code ?? "UNKNOWN" });
    });
    const actual = helperReadmeVersion(content);
    if (actual !== version) mismatches.push({ path: name, repository: "helper", expected: version, actual });
  }

  mismatchError(version, mismatches);
  return {
    ok: true,
    reasonCode: "RELEASE_VERSION_CHECKED",
    version,
    engine: engine.root,
    helper: helper.root,
    packageFiles: packageFiles.map((path) => path.slice(engine.root.length + 1)),
    changelog: CHANGELOG_FILE,
    readmes: README_NAMES,
    skill: `skill/${HELPER_PACKAGE_NAME}/SKILL.md`,
  };
}

function parseCommandJson(result, label) {
  if (result.status !== 0) {
    refuse("RELEASE_STEP_FAILED", `${label} failed`, { step: label, status: result.status, stderr: result.stderr.trim(), stdout: result.stdout.trim() });
  }
  const lines = result.stdout.trim().split("\n").filter((line) => line !== "");
  try {
    return JSON.parse(lines.at(-1) ?? "");
  } catch (error) {
    refuse("RELEASE_STEP_FAILED", `${label} did not return a JSON result`, { step: label, stderr: result.stderr.trim(), stdout: result.stdout.trim(), error: String(error?.message ?? error) });
  }
}

function writeResult(command, args, { cwd, env, runner } = {}) {
  return runner ? runner(command, args, { cwd, env }) : run(command, args, { cwd, env });
}

function releaseCli(engineRoot, args, env) {
  return parseCommandJson(run(process.execPath, [join(engineRoot, "scripts/einzbern.mjs"), ...args], { cwd: engineRoot, env }), args[0]);
}

function inside(parent, candidate) {
  const path = relative(parent, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !path.startsWith(sep));
}

/** Read the actual CLI's release plan and its registered roots; never create a release library. */
export async function checkReleaseGatePlan({ engineRoot, helperRoot, workspace, projectRoot, env = process.env }) {
  if (typeof projectRoot !== "string" || projectRoot.length === 0) {
    refuse("RELEASE_PROJECT_REQUIRED", "prepare needs the explicitly registered project for release gates");
  }
  if (typeof workspace !== "string" || workspace.length === 0) {
    refuse("RELEASE_WORKSPACE_REQUIRED", "prepare needs a library path for release gates");
  }
  const project = await realpath(resolve(projectRoot));
  const library = await realpath(resolve(workspace));
  const sources = await Promise.all([engineRoot, helperRoot].map((root) => realpath(resolve(root))));
  if (sources.some((root) => !inside(project, root))) {
    refuse("RELEASE_GATE_ROOT_MISMATCH", "the registered gate project must contain the engine and helper release trees", { project, sources });
  }
  const registry = releaseCli(engineRoot, ["library-list"], env);
  const entry = registry.entries?.find((candidate) => candidate.projectPath === project && candidate.libraryPath === library);
  if (entry === undefined) refuse("RELEASE_GATE_REGISTRY_MISMATCH", "the explicit project and library are not registered together on this device", { project, workspace: library });
  const declared = releaseCli(engineRoot, ["gates-config-list", "--workspace", library], env);
  if (declared.truncated !== false || !Array.isArray(declared.records) || declared.records.length !== declared.total) {
    refuse("RELEASE_GATE_DECLARATIONS_INVALID", "release needs the complete gate declaration list", { declared });
  }
  if (declared.workspaceId !== entry.libraryId) refuse("RELEASE_GATE_REGISTRY_MISMATCH", "the registry library id differs from the named library", { project, workspace: library });
  if (declared.records.length === 0) refuse("RELEASE_GATE_DECLARATIONS_EMPTY", "a release cannot pass without declared gates");
  const enabled = declared.records.filter((gate) => gate.enabled);
  if (!enabled.some((gate) => gate.required)) refuse("RELEASE_REQUIRED_GATES_MISSING", "a release needs enabled required gates");
  const plan = releaseCli(engineRoot, ["gates-plan", "--workspace", library, "--project", project, "--release", "true"], env);
  if (plan.reasonCode !== "GATES_PLAN_READY" || plan.workspaceId !== entry.libraryId || plan.projectRoot !== project || plan.release !== true || !Array.isArray(plan.gates)) {
    refuse("RELEASE_GATE_PLAN_INVALID", "the release plan does not bind the explicit project and library", { plan });
  }
  const { gateDeclarationsDigest, resolveGateRoot } = await builtReleaseModule(engineRoot, "packages/core/src/gates-plan.js");
  if (plan.declarationsDigest !== gateDeclarationsDigest(enabled) || plan.gates.length !== enabled.length || new Set(plan.gates.map((gate) => gate.name)).size !== enabled.length) {
    refuse("RELEASE_GATE_SELECTION_MISMATCH", "the release plan must select every enabled declaration exactly once", { plan });
  }
  for (const gate of enabled) {
    const selected = plan.gates.find((candidate) => candidate.name === gate.name);
    if (selected === undefined || selected.root !== gate.root || selected.required !== gate.required || selected.releaseOnly !== gate.releaseOnly || JSON.stringify(selected.command) !== JSON.stringify(gate.command)) {
      refuse("RELEASE_GATE_SELECTION_MISMATCH", "a release declaration is absent or differs in the selected plan", { gate: gate.name });
    }
  }
  const roots = await Promise.all(plan.gates.filter((gate) => gate.required).map((gate) => resolveGateRoot(project, gate.root)));
  for (const source of sources) {
    if (!roots.includes(source)) refuse("RELEASE_REQUIRED_GATES_MISSING", "each release repository needs a required gate on that exact tree", { source, roots });
  }
  return { plan, workspace: library, projectRoot: project };
}

/** Validate the saved native run against its real selection, declarations and tree. */
export async function assertReleaseGateRun({ gates, plan, tree, at }) {
  const result = gates?.run;
  if (gates?.reasonCode !== "GATES_RUN_COMPLETED" || !isRecord(result) || result.schemaVersion !== "einzbern.gate-run.v1" || result.libraryId !== plan.workspaceId || gates.workspaceId !== plan.workspaceId || result.release !== true || result.at !== at || result.declarationsDigest !== plan.declarationsDigest || result.treeDigest !== tree.treeDigest || canonicalJson(result.trees) !== canonicalJson(tree.trees) || !Array.isArray(result.gates)) {
    refuse("RELEASE_GATE_RUN_INVALID", "the release run does not bind the actual selected tree and declarations", { gates });
  }
  if (result.gates.length !== plan.gates.length || result.gates.some((gate, index) => gate.name !== plan.gates[index].name || gate.root !== plan.gates[index].root || gate.required !== plan.gates[index].required)) {
    refuse("RELEASE_GATE_EXECUTION_MISMATCH", "every selected release gate must execute exactly once", { gates });
  }
  const reds = result.gates.filter((gate) => gate.ok !== true || gate.exitCode !== 0 || gate.signal !== null || gate.timedOut !== false).map((gate) => gate.name);
  if (gates.ok !== true || reds.length > 0 || JSON.stringify(gates.reds) !== "[]" || JSON.stringify(gates.requiredReds) !== "[]" || JSON.stringify(result.reds) !== "[]") {
    refuse("RELEASE_GATES_RED", "release gates reported one or more red results", { gates, reds });
  }
  const saved = await readJson(gates.recordPath);
  if (JSON.stringify(saved) !== JSON.stringify(result)) refuse("RELEASE_GATE_RECEIPT_MISMATCH", "the native saved gate run differs from its result", { recordPath: gates.recordPath });
  return gates;
}

export async function runReleaseGates({ engineRoot, helperRoot, workspace, projectRoot, env = process.env, at = utcNow() }) {
  const bound = await checkReleaseGatePlan({ engineRoot, helperRoot, workspace, projectRoot, env });
  const { gateTreeState } = await builtReleaseModule(engineRoot, "packages/core/src/gates-run.js");
  const tree = await gateTreeState(bound.projectRoot, bound.plan.roots);
  const gates = releaseCli(engineRoot, ["gates-run", "--workspace", bound.workspace, "--project", bound.projectRoot, "--release", "true", "--at", at], env);
  await assertReleaseGateRun({ gates, plan: bound.plan, tree, at });
  const after = await checkReleaseGatePlan({ engineRoot, helperRoot, workspace, projectRoot, env });
  const afterTree = await gateTreeState(bound.projectRoot, after.plan.roots);
  if (after.plan.declarationsDigest !== bound.plan.declarationsDigest || afterTree.treeDigest !== tree.treeDigest) {
    refuse("RELEASE_GATE_BASIS_CHANGED", "the release tree or declarations changed during the gate run", { before: tree.treeDigest, after: afterTree.treeDigest });
  }
  return gates;
}

function changelogForPrepare(source, version) {
  const headings = [...source.matchAll(/^## Unreleased[ \t]*\r?$/gmu)];
  if (headings.length !== 1) refuse("RELEASE_CHANGELOG_UNRELEASED_MISSING", "CHANGELOG.md must have exactly one Unreleased section", { count: headings.length });
  if (changelogSection(source, version) !== null) refuse("RELEASE_CHANGELOG_VERSION_EXISTS", `CHANGELOG.md already has a ${version} section`, { version });

  const heading = headings[0];
  const bodyStart = heading.index + heading[0].length;
  const remainder = source.slice(bodyStart).replace(/^\r?\n/u, "");
  const next = /^## [^\r\n]+/mu.exec(remainder);
  const body = (next ? remainder.slice(0, next.index) : remainder).trim();
  if (body.length === 0) refuse("RELEASE_CHANGELOG_EMPTY", "the Unreleased section has no release notes to cut", {});
  const suffix = next ? remainder.slice(next.index) : "";
  const prefix = source.slice(0, heading.index);
  const releaseNotes = `## ${version}\n\n${RELEASE_SUMMARY(version)}\n\n${body}\n`;
  return `${prefix}## Unreleased\n\n${releaseNotes}${suffix.length === 0 ? "" : `\n${suffix}`}`;
}

async function updatePackageVersion(path, version) {
  const manifest = await readJson(path);
  if (typeof manifest.version !== "string" || !RELEASE_VERSION_SHAPE.test(manifest.version)) {
    refuse("RELEASE_VERSION_INVALID", `${path} does not contain a stable version`, { path, version: manifest.version ?? null });
  }
  manifest.version = version;
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

function utcNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/u, "Z");
}

async function validatePackOutput(engineRoot, version) {
  const archive = join(engineRoot, RELEASE_OUTPUT_DIRECTORY, RELEASE_ASSET(version));
  const checksum = `${archive}.sha256`;
  const bytes = await readFile(archive).catch((error) => {
    refuse("RELEASE_ASSET_MISSING", `pack-release did not create ${archive}`, { path: archive, code: error?.code ?? "UNKNOWN" });
  });
  const shaFile = await readFile(checksum, "utf8").catch((error) => {
    refuse("RELEASE_ASSET_MISSING", `pack-release did not create ${checksum}`, { path: checksum, code: error?.code ?? "UNKNOWN" });
  });
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (shaFile !== `${sha256}  ${RELEASE_ASSET(version)}\n`) {
    refuse("RELEASE_ASSET_DIGEST_MISMATCH", `${checksum} does not match the release archive`, { archive, checksum, expected: sha256, actual: shaFile.trim() });
  }
  return { archive, checksum, sha256 };
}

// The engine's state before a release version is written: every manifest carries one stable
// version, and the core source and its build answer as that version.
async function currentReleaseState(engineRoot) {
  const packagePaths = [join(engineRoot, "package.json"), ...await enginePackagePaths(engineRoot)];
  const sourceVersions = [];
  for (const path of packagePaths) {
    const manifest = await readJson(path);
    if (typeof manifest.version !== "string" || !RELEASE_VERSION_SHAPE.test(manifest.version)) {
      refuse("RELEASE_VERSION_INVALID", `${path} does not contain a stable version`, { path, version: manifest.version ?? null });
    }
    sourceVersions.push({ path: path.slice(engineRoot.length + 1), version: manifest.version });
  }
  const currentVersions = new Set(sourceVersions.map((entry) => entry.version));
  if (currentVersions.size !== 1) {
    refuse("RELEASE_VERSION_MISMATCH", "engine package versions disagree before prepare", { mismatches: sourceVersions });
  }
  const framework = await releaseFrameworkVersions(engineRoot);
  mismatchError([...currentVersions][0], [
    versionMismatch([...currentVersions][0], FRAMEWORK_VERSION_SOURCE, framework.sourceVersion),
    versionMismatch([...currentVersions][0], FRAMEWORK_VERSION_BUILT, framework.builtVersion),
  ].filter(Boolean));
  return { packagePaths, framework };
}

async function cutReleaseChangelog(engineRoot, version) {
  const changelogPath = join(engineRoot, CHANGELOG_FILE);
  const changelog = await readFile(changelogPath, "utf8").catch((error) => {
    refuse("RELEASE_FILE_MISSING", `${CHANGELOG_FILE} does not exist`, { path: CHANGELOG_FILE, code: error?.code ?? "UNKNOWN" });
  });
  return { changelogPath, nextChangelog: changelogForPrepare(changelog, version) };
}

async function writeReleaseVersion({ engineRoot, version, state, changelog }) {
  for (const path of state.packagePaths) await updatePackageVersion(path, version);
  const { framework } = state;
  const declaration = framework.declaration;
  await writeFile(join(engineRoot, FRAMEWORK_VERSION_SOURCE), `${framework.source.slice(0, declaration.index)}${declaration[0].replace(`"${declaration[1]}"`, `"${version}"`)}${framework.source.slice(declaration.index + declaration[0].length)}`);
  await writeFile(changelog.changelogPath, changelog.nextChangelog);
}

async function buildReleaseTree({ engineRoot, version, env, runner }) {
  const build = parseCommandJson(await writeResult("corepack", ["pnpm@11.3.0", "--dir", engineRoot, "run", "build"], { cwd: engineRoot, env, runner }), "build");
  if (build.ok === false) refuse("RELEASE_BUILD_FAILED", "the release build reported failure", { build });
  const rebuilt = await releaseFrameworkVersions(engineRoot);
  mismatchError(version, [versionMismatch(version, FRAMEWORK_VERSION_BUILT, rebuilt.builtVersion)].filter(Boolean));
  return { reasonCode: build.reasonCode ?? null, builtVersion: rebuilt.builtVersion };
}

async function renderEngineReadmes({ engineRoot, version, env, runner }) {
  const readme = parseCommandJson(await writeResult(process.execPath, [join(engineRoot, "scripts", "render-readme.mjs"), "--version", version], { cwd: engineRoot, env, runner }), "render-readme");
  if (readme.ok === false) refuse("RELEASE_README_RENDER_FAILED", "render-readme reported drift or failure", { readme });
  return readme;
}

async function renderHelperTree({ engineRoot, helperRoot, version, env, runner }) {
  const helperDocs = parseCommandJson(await writeResult(process.execPath, [join(engineRoot, "scripts", "render-helper-docs.mjs"), "--out", helperRoot, "--version", version], { cwd: engineRoot, env, runner }), "render-helper-docs");
  if (helperDocs.ok === false || helperDocs.reasonCode !== "HELPER_DOCS_RENDERED") {
    refuse("RELEASE_HELPER_RENDER_FAILED", "render-helper-docs did not complete", { helperDocs });
  }
  return helperDocs;
}

async function packRelease({ engineRoot, version, env, runner }) {
  const pack = parseCommandJson(await writeResult(process.execPath, [join(engineRoot, "scripts", "pack-release.mjs"), "--version", version], { cwd: engineRoot, env, runner }), "pack-release");
  if (pack.ok === false || pack.reasonCode !== "RELEASE_PACKED") refuse("RELEASE_PACK_FAILED", "pack-release did not complete", { pack });
  return validatePackOutput(engineRoot, version);
}

function gateSummary(gates) {
  return { reasonCode: gates.reasonCode, ok: gates.ok, reds: gates.reds, selected: gates.run.gates.map((gate) => gate.name), treeDigest: gates.run.treeDigest, declarationsDigest: gates.run.declarationsDigest, recordPath: gates.recordPath };
}

export async function prepareRelease({ engineRoot, helperRoot, version, workspace = null, projectRoot = null, env = process.env, runner = null, at = utcNow() }) {
  if (typeof version !== "string" || !RELEASE_VERSION_SHAPE.test(version)) {
    refuse("RELEASE_VERSION_INVALID", `${String(version)} is not a stable release version`, { version: String(version) });
  }
  if (workspace === null || workspace === undefined || String(workspace).length === 0) {
    refuse("RELEASE_WORKSPACE_REQUIRED", "prepare needs a library path for gates-run --release", {});
  }
  const engine = await assertRepository(engineRoot, ENGINE_PACKAGE_NAME, { clean: true, env });
  const helper = await assertRepository(helperRoot, HELPER_PACKAGE_NAME, { clean: true, env });
  ensureSeparateRepositories(engine.root, helper.root);
  // Read the existing declaration and registry before changing either release tree. These reads
  // and the actual gate process bypass a test runner: a synthetic ok cannot prove a release.
  await checkReleaseGatePlan({ engineRoot: engine.root, helperRoot: helper.root, workspace, projectRoot, env });

  const state = await currentReleaseState(engine.root);
  const changelog = await cutReleaseChangelog(engine.root, version);
  await writeReleaseVersion({ engineRoot: engine.root, version, state, changelog });
  await buildReleaseTree({ engineRoot: engine.root, version, env, runner });
  await renderEngineReadmes({ engineRoot: engine.root, version, env, runner });
  const helperDocs = await renderHelperTree({ engineRoot: engine.root, helperRoot: helper.root, version, env, runner });

  const gates = await runReleaseGates({ engineRoot: engine.root, helperRoot: helper.root, workspace, projectRoot, env, at });

  const assets = await packRelease({ engineRoot: engine.root, version, env, runner });
  const checked = await checkRelease({ engineRoot: engine.root, helperRoot: helper.root, version, env });
  return {
    ok: true,
    reasonCode: "RELEASE_PREPARED",
    version,
    at,
    gates: gateSummary(gates),
    assets,
    check: checked.reasonCode,
    helperExtraFiles: helperDocs.extraFiles ?? [],
  };
}

// TCRN-CROSS-SUB-357 rev4, Owner 2026-10-08 item 4 (Method6): a release is prepared in two
// phases around one local release commit per repository. `generate` writes the release files and
// a receipt, and commits nothing and runs no gate. The caller then commits each tree exactly once:
// the engine commit is the receipt's changes, the helper commit is the receipt's changes plus
// `git rm` of its removeFiles. `finish` proves those two commits are the receipt before it moves
// stale release artifacts aside, runs the release gates and packs. Both refuse with every failed
// condition of a step at once (details.violations, the first one's reason code on top).

function gitList(root, args, env) {
  const result = run("git", ["-C", root, ...args], { cwd: root, env });
  if (result.status !== 0) {
    refuse("RELEASE_GIT_FAILED", `git ${args.join(" ")} failed in ${root}`, { root, args, stderr: result.stderr.trim() });
  }
  return result.stdout.split("\0").filter((field) => field !== "");
}

function sha256Hex(content) {
  return createHash("sha256").update(content).digest("hex");
}

function sortedPaths(paths) {
  return [...paths].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

// Record a failure of `operation` as a violation instead of stopping at it; a failure without its
// own reason code (an unreadable build, for one) is still a violation, never a pass.
async function collect(violations, operation) {
  try {
    return await operation();
  } catch (error) {
    violations.push({
      code: typeof error?.reasonCode === "string" ? error.reasonCode : "RELEASE_PRECONDITION_FAILED",
      message: String(error?.message ?? error),
      ...(isRecord(error?.details) ? { details: error.details } : {}),
    });
    return undefined;
  }
}

function refuseViolations(violations, message) {
  if (violations.length > 0) refuse(violations[0].code, message, { violations });
}

// A linked worktree's .git is a file: the engine build, every gate and the output session that
// moves stale release artifacts refuse it, so a release runs on a real checkout.
async function engineCheckoutViolation(root) {
  const metadata = await lstat(join(root, ".git")).catch(() => null);
  if (metadata !== null && !metadata.isSymbolicLink() && metadata.isDirectory()) return null;
  return { code: "RELEASE_ENGINE_CHECKOUT_LINKED", root, message: "the engine release runs on a checkout whose .git is a directory, not on a linked worktree" };
}

async function receiptLocation(receiptPath, roots, violations) {
  const requested = resolve(receiptPath);
  const parent = await stat(dirname(requested)).catch(() => null);
  if (parent === null || !parent.isDirectory()) {
    violations.push({ code: "RELEASE_RECEIPT_INVALID", receipt: requested, message: "the receipt's directory must already exist" });
    return requested;
  }
  const location = join(await realpath(dirname(requested)), basename(requested));
  if (roots.some((root) => inside(root, location))) {
    violations.push({ code: "RELEASE_RECEIPT_INSIDE_REPOSITORY", receipt: location, message: "a receipt inside a release repository would change that tree" });
  }
  if (await lstat(location).then(() => true, () => false)) {
    violations.push({ code: "RELEASE_RECEIPT_EXISTS", receipt: location, message: "generate never overwrites a receipt" });
  }
  return location;
}

function keepExtraViolations(helperRoot, keepExtra, env) {
  const violations = [];
  const tracked = new Set(gitList(helperRoot, ["ls-files", "-z"], env));
  const named = new Set();
  for (const path of keepExtra) {
    const relativePath = typeof path === "string" && path !== "" && !path.startsWith("/") && !path.includes("\\") && path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
    if (!relativePath) violations.push({ code: "RELEASE_KEEP_EXTRA_UNKNOWN", path: String(path), message: "--keep-extra names a relative path of the helper repository" });
    else if (named.has(path)) violations.push({ code: "RELEASE_KEEP_EXTRA_UNKNOWN", path, message: "--keep-extra names this path twice" });
    else if (!tracked.has(path)) violations.push({ code: "RELEASE_KEEP_EXTRA_UNKNOWN", path, message: "--keep-extra names a file the helper repository does not track" });
    if (relativePath) named.add(path);
  }
  return violations;
}

// The working-tree changes the generation made, read from git: an added (untracked) or modified
// regular file, with its exact bytes. Anything else is not a generated release file.
async function generatedChanges(repository, root, env, violations) {
  const changes = [];
  for (const record of gitList(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"], env)) {
    const code = record.slice(0, 2);
    const path = record.slice(3);
    const status = code === "??" ? "A" : /^[ M]M$|^M[ M]$/u.test(code) ? "M" : null;
    const metadata = status === null ? null : await lstat(join(root, ...path.split("/"))).catch(() => null);
    if (metadata === null || !metadata.isFile()) {
      violations.push({ code: "RELEASE_GENERATED_ENTRY_INVALID", repository, path, status: code, message: "a release generation only adds or modifies regular files" });
      continue;
    }
    const content = await readFile(join(root, ...path.split("/")));
    changes.push({ path, status, bytes: content.length, sha256: sha256Hex(content) });
  }
  return changes.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

// The complete committed bytes of a regular file, read through its blob id as the release
// preflight reads them (scripts/task.mjs release-preflight).
function committedSource(root, commit, path, env) {
  const record = git(root, ["ls-tree", commit, "--", path], env);
  const matched = new RegExp(`^100644 blob ([0-9a-f]{40,64})\\t${escapeRegExp(path)}$`, "u").exec(record);
  if (matched === null) refuse("RELEASE_COMMIT_FRAMEWORK_INVALID", `${path} must be a regular committed blob`, { root, commit, path });
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(gitRaw(root, ["cat-file", "blob", matched[1]], env));
  } catch (error) {
    if (error instanceof ReleaseLockstepError) throw error;
    return refuse("RELEASE_COMMIT_FRAMEWORK_INVALID", `${path} must be complete UTF-8`, { root, commit, path });
  }
}

// The release commit shape over the engine's changed paths, with the evidence the release
// preflight supplies: the complete core source before and after, the README rendering check, and
// the CLI reference check only when that page changed.
async function releaseShape({ engineRoot, changedPaths, version, frameworkBefore, frameworkAfter, cliReferenceChecked }) {
  const input = { changedPaths, version };
  if (changedPaths.includes(FRAMEWORK_VERSION_SOURCE)) {
    input.frameworkBefore = await frameworkBefore();
    input.frameworkAfter = await frameworkAfter();
  }
  if (changedPaths.some((path) => README_NAMES.includes(path))) input.generatedReadmes = await renderReadmes({ root: engineRoot, version, check: true });
  if (changedPaths.includes(CLI_REFERENCE_FILE)) input.cliReferenceChecked = await cliReferenceChecked();
  return assertReleaseCommitShape(input);
}

async function checkCliReference({ engineRoot, env, runner }) {
  const script = join(engineRoot, "scripts", "wiki-cli-reference.mjs");
  const step = async (args) => {
    const result = await writeResult(process.execPath, [script, ...args], { cwd: engineRoot, env, runner });
    return { status: result.status, stdout: String(result.stdout ?? "").trim(), stderr: String(result.stderr ?? "").trim() };
  };
  const checked = await step(["--check"]);
  if (checked.status === 0) return { checked: true, changed: false };
  if (!checked.stderr.includes("CLI_REFERENCE_OUT_OF_DATE")) refuse("RELEASE_CLI_REFERENCE_FAILED", "the CLI reference check failed", { step: "check", ...checked });
  const written = await step([]);
  if (written.status !== 0) refuse("RELEASE_CLI_REFERENCE_FAILED", "the CLI reference could not be regenerated", { step: "write", ...written });
  const rechecked = await step(["--check"]);
  if (rechecked.status !== 0) refuse("RELEASE_CLI_REFERENCE_FAILED", "the regenerated CLI reference does not pass its check", { step: "recheck", ...rechecked });
  return { checked: true, changed: true };
}

export async function generateRelease({ engineRoot, helperRoot, version, workspace = null, projectRoot = null, receiptPath = null, keepExtra = [], env = process.env, runner = null, at = utcNow() }) {
  if (typeof version !== "string" || !RELEASE_VERSION_SHAPE.test(version)) {
    refuse("RELEASE_VERSION_INVALID", `${String(version)} is not a stable release version`, { version: String(version) });
  }
  if (typeof receiptPath !== "string" || receiptPath.length === 0) refuse("RELEASE_RECEIPT_REQUIRED", "generate needs a receipt path outside both repositories");
  const kept = Array.isArray(keepExtra) ? keepExtra : [keepExtra];
  const engine = await assertRepository(engineRoot, ENGINE_PACKAGE_NAME, { clean: true, env });
  const helper = await assertRepository(helperRoot, HELPER_PACKAGE_NAME, { clean: true, env });
  ensureSeparateRepositories(engine.root, helper.root);

  // Every precondition is read before either tree changes, and all failed ones refuse together.
  const before = [];
  const linked = await engineCheckoutViolation(engine.root);
  if (linked !== null) before.push(linked);
  const receipt = await receiptLocation(receiptPath, [engine.root, helper.root], before);
  before.push(...keepExtraViolations(helper.root, kept, env));
  const notePath = `${RELEASE_NOTE_DIRECTORY}/${version}.md`;
  if (await lstat(join(engine.root, ...notePath.split("/"))).then(() => true, () => false)) {
    before.push({ code: "RELEASE_NOTE_EXISTS", path: notePath, message: "the release note of this version already exists" });
  }
  const bound = await collect(before, () => checkReleaseGatePlan({ engineRoot: engine.root, helperRoot: helper.root, workspace, projectRoot, env }));
  const state = await collect(before, () => currentReleaseState(engine.root));
  const changelog = await collect(before, () => cutReleaseChangelog(engine.root, version));
  refuseViolations(before, "release generation preconditions failed; neither tree was changed");
  const heads = { engine: git(engine.root, ["rev-parse", "HEAD"], env), helper: git(helper.root, ["rev-parse", "HEAD"], env) };

  await writeReleaseVersion({ engineRoot: engine.root, version, state, changelog });
  await mkdir(join(engine.root, ...RELEASE_NOTE_DIRECTORY.split("/")), { recursive: true });
  await writeFile(join(engine.root, ...notePath.split("/")), `# Einzbern ${version}\n\n${changelogSection(changelog.nextChangelog, version)}\n`, { flag: "wx" });
  const build = await buildReleaseTree({ engineRoot: engine.root, version, env, runner });
  const readme = await renderEngineReadmes({ engineRoot: engine.root, version, env, runner });
  const cliReference = await checkCliReference({ engineRoot: engine.root, env, runner });
  const helperDocs = await renderHelperTree({ engineRoot: engine.root, helperRoot: helper.root, version, env, runner });
  if (!Array.isArray(helperDocs.files) || !Array.isArray(helperDocs.extraFiles)) {
    refuse("RELEASE_HELPER_RENDER_FAILED", "render-helper-docs did not list its generated and extra files", { helperDocs });
  }

  const after = [];
  const generated = new Set(helperDocs.files);
  const extras = sortedPaths(helperDocs.extraFiles);
  const trackedHelper = new Set(gitList(helper.root, ["ls-files", "-z"], env));
  const trackedExtras = extras.filter((path) => trackedHelper.has(path));
  for (const path of kept) {
    if (!trackedExtras.includes(path)) after.push({ code: "RELEASE_KEEP_EXTRA_UNKNOWN", path, message: "--keep-extra names a file that is not a tracked extra file of the generated helper tree" });
  }
  const keptExtraFiles = sortedPaths(new Set(kept));
  const removeFiles = trackedExtras.filter((path) => !keptExtraFiles.includes(path));
  const keptFiles = sortedPaths([...trackedHelper].filter((path) => !generated.has(path) && !extras.includes(path)));
  const engineChanges = await generatedChanges("engine", engine.root, env, after);
  const helperChanges = await generatedChanges("helper", helper.root, env, after);
  const commitShape = await collect(after, () => releaseShape({
    engineRoot: engine.root,
    changedPaths: engineChanges.map((change) => change.path),
    version,
    frameworkBefore: () => committedSource(engine.root, "HEAD", FRAMEWORK_VERSION_SOURCE, env),
    frameworkAfter: () => readFile(join(engine.root, FRAMEWORK_VERSION_SOURCE), "utf8"),
    cliReferenceChecked: () => cliReference.checked,
  }));
  refuseViolations(after, "the generated trees do not form a valid release commit; the generated changes remain uncommitted");

  const document = {
    schemaVersion: RELEASE_RECEIPT_SCHEMA,
    version,
    at,
    engine: { root: engine.root, head: heads.engine, changes: engineChanges },
    helper: {
      root: helper.root,
      head: heads.helper,
      changes: helperChanges,
      generatedFiles: sortedPaths(generated),
      keptFiles,
      extraFiles: { tracked: trackedExtras, untracked: extras.filter((path) => !trackedHelper.has(path)) },
      keptExtraFiles,
      removeFiles,
    },
    gates: { workspace: bound.workspace, projectRoot: bound.projectRoot, libraryId: bound.plan.workspaceId, declarationsDigest: bound.plan.declarationsDigest },
    generated: {
      releaseNote: notePath,
      build,
      readme: { reasonCode: readme.reasonCode ?? null },
      cliReference,
      helperDocs: { reasonCode: helperDocs.reasonCode, skillInstallTreeDigest: helperDocs.skillInstallTreeDigest ?? null },
      commitShape,
    },
  };
  await writeFile(receipt, `${JSON.stringify(document, null, 2)}\n`, { flag: "wx" }).catch((error) => {
    refuse(error?.code === "EEXIST" ? "RELEASE_RECEIPT_EXISTS" : "RELEASE_RECEIPT_INVALID", `the receipt ${receipt} could not be written`, { receipt, code: error?.code ?? "UNKNOWN" });
  });
  return {
    ok: true,
    reasonCode: "RELEASE_GENERATED",
    version,
    at,
    receipt,
    engine: { head: heads.engine, changes: engineChanges.length },
    helper: { head: heads.helper, changes: helperChanges.length, keptExtraFiles, removeFiles, untrackedExtraFiles: document.helper.extraFiles.untracked },
    gates: document.gates,
    cliReference,
  };
}

function receiptProblems(document) {
  const problems = [];
  const text = (value) => typeof value === "string" && value.length > 0;
  const list = (value) => Array.isArray(value) && value.every(text);
  const changes = (value) => Array.isArray(value) && value.every((change) => isRecord(change) && text(change.path) && (change.status === "A" || change.status === "M") && Number.isSafeInteger(change.bytes) && change.bytes >= 0 && /^[0-9a-f]{64}$/u.test(change.sha256 ?? ""));
  if (!isRecord(document)) return ["the receipt is not a JSON object"];
  if (document.schemaVersion !== RELEASE_RECEIPT_SCHEMA) problems.push("schemaVersion");
  if (!text(document.version)) problems.push("version");
  for (const name of ["engine", "helper"]) {
    const repository = document[name];
    if (!isRecord(repository) || !text(repository.root) || !COMMIT_ID_SHAPE.test(repository.head ?? "") || !changes(repository.changes)) problems.push(name);
  }
  const helper = isRecord(document.helper) ? document.helper : {};
  for (const field of ["keptFiles", "keptExtraFiles", "removeFiles"]) if (!list(helper[field])) problems.push(`helper.${field}`);
  if (!isRecord(helper.extraFiles) || !list(helper.extraFiles.tracked) || !list(helper.extraFiles.untracked)) problems.push("helper.extraFiles");
  const gates = isRecord(document.gates) ? document.gates : {};
  for (const field of ["workspace", "projectRoot", "libraryId", "declarationsDigest"]) if (!text(gates[field])) problems.push(`gates.${field}`);
  return problems;
}

async function readReleaseReceipt(receiptPath) {
  const location = resolve(receiptPath);
  const metadata = await lstat(location).catch((error) => {
    refuse("RELEASE_RECEIPT_MISSING", `${location} does not exist`, { receipt: location, code: error?.code ?? "UNKNOWN" });
  });
  if (!metadata.isFile()) refuse("RELEASE_RECEIPT_INVALID", `${location} is not a regular file`, { receipt: location });
  let document;
  try {
    document = JSON.parse(await readFile(location, "utf8"));
  } catch (error) {
    refuse("RELEASE_RECEIPT_INVALID", `${location} is not valid JSON`, { receipt: location, error: String(error?.message ?? error) });
  }
  const problems = receiptProblems(document);
  if (problems.length > 0) refuse("RELEASE_RECEIPT_INVALID", `${location} is not a ${RELEASE_RECEIPT_SCHEMA} receipt`, { receipt: location, problems });
  return { location, document };
}

// Exactly one single-parent commit on top of the HEAD the receipt recorded.
function releaseCommit(repository, root, recorded, env, violations) {
  if (run("git", ["-C", root, "rev-parse", "--verify", "--quiet", `${recorded}^{commit}`], { cwd: root, env }).status !== 0) {
    violations.push({ code: "RELEASE_RECEIPT_MISMATCH", repository, field: `${repository}.head`, expected: "a commit of this repository", actual: recorded });
    return null;
  }
  const commit = git(root, ["rev-parse", "HEAD"], env);
  const count = Number(git(root, ["rev-list", "--count", `${recorded}..HEAD`], env));
  const parents = git(root, ["rev-list", "--parents", "-n", "1", "HEAD"], env).split(/\s+/u).slice(1);
  if (count !== 1) {
    violations.push({ code: "RELEASE_COMMIT_COUNT_INVALID", repository, expected: 1, actual: count, message: "each repository needs exactly one release commit after the recorded HEAD" });
    return null;
  }
  if (parents.length !== 1 || parents[0] !== recorded) {
    violations.push({ code: "RELEASE_COMMIT_PARENT_INVALID", repository, expected: [recorded], actual: parents, message: "the release commit's only parent is the recorded HEAD" });
    return null;
  }
  return { parent: recorded, commit };
}

function blobId(root, commit, path, env) {
  const result = run("git", ["-C", root, "rev-parse", "--verify", "--quiet", `${commit}:${path}`], { cwd: root, env });
  return result.status === 0 ? result.stdout.trim() : null;
}

// The committed changes of one repository against the receipt: every added or modified path with
// its exact bytes, every path to remove as a deletion, and nothing else.
function committedChangeViolations({ repository, root, parent, recorded, removeFiles = [], env, violations }) {
  const fields = gitList(root, ["diff", "--name-status", "--no-renames", "-z", parent, "HEAD", "--"], env);
  const committed = [];
  for (let index = 0; index + 1 < fields.length; index += 2) committed.push({ status: fields[index], path: fields[index + 1] });
  const expected = new Map(recorded.map((change) => [change.path, change]));
  const removals = new Set(removeFiles);
  const seen = new Set();
  const mismatch = (path, wanted, found) => violations.push({ code: "RELEASE_COMMIT_CONTENT_MISMATCH", repository, path, expected: wanted, actual: found });
  for (const change of committed) {
    seen.add(change.path);
    if (removals.has(change.path)) {
      if (change.status !== "D") mismatch(change.path, "D", change.status);
      continue;
    }
    const wanted = expected.get(change.path);
    if (wanted === undefined) mismatch(change.path, "unchanged", change.status);
    else if (wanted.status !== change.status) mismatch(change.path, wanted.status, change.status);
    else {
      const blob = gitRaw(root, ["cat-file", "blob", `HEAD:${change.path}`], env);
      const found = { bytes: blob.length, sha256: sha256Hex(blob) };
      if (found.bytes !== wanted.bytes || found.sha256 !== wanted.sha256) mismatch(change.path, { bytes: wanted.bytes, sha256: wanted.sha256 }, found);
    }
  }
  for (const change of recorded) if (!seen.has(change.path)) mismatch(change.path, change.status, "unchanged");
  for (const path of removeFiles) if (!seen.has(path)) mismatch(path, "D", "unchanged");
  return committed.map((change) => change.path);
}

export async function finishRelease({ engineRoot, helperRoot, version, workspace = null, projectRoot = null, receiptPath = null, env = process.env, runner = null, at = utcNow() }) {
  if (typeof version !== "string" || !RELEASE_VERSION_SHAPE.test(version)) {
    refuse("RELEASE_VERSION_INVALID", `${String(version)} is not a stable release version`, { version: String(version) });
  }
  if (typeof receiptPath !== "string" || receiptPath.length === 0) refuse("RELEASE_RECEIPT_REQUIRED", "finish needs the receipt that generate wrote");
  const engine = await assertRepository(engineRoot, ENGINE_PACKAGE_NAME, { clean: true, env });
  const helper = await assertRepository(helperRoot, HELPER_PACKAGE_NAME, { clean: true, env });
  ensureSeparateRepositories(engine.root, helper.root);
  const { location, document: receipt } = await readReleaseReceipt(receiptPath);

  // Every check of the two commits against the receipt runs, and all failures refuse together.
  const violations = [];
  const linked = await engineCheckoutViolation(engine.root);
  if (linked !== null) violations.push(linked);
  const named = async (path) => (typeof path === "string" && path.length > 0 ? realpath(resolve(path)).catch(() => resolve(path)) : null);
  for (const [field, expected, actual] of [
    ["version", version, receipt.version],
    ["engine.root", engine.root, receipt.engine.root],
    ["helper.root", helper.root, receipt.helper.root],
    ["gates.workspace", await named(workspace), receipt.gates.workspace],
    ["gates.projectRoot", await named(projectRoot), receipt.gates.projectRoot],
  ]) {
    if (expected !== actual) violations.push({ code: "RELEASE_RECEIPT_MISMATCH", field, expected, actual });
  }
  const commits = {
    engine: releaseCommit("engine", engine.root, receipt.engine.head, env, violations),
    helper: releaseCommit("helper", helper.root, receipt.helper.head, env, violations),
  };
  let commitShape;
  if (commits.engine !== null) {
    const changedPaths = committedChangeViolations({ repository: "engine", root: engine.root, parent: commits.engine.parent, recorded: receipt.engine.changes, env, violations });
    commitShape = await collect(violations, () => releaseShape({
      engineRoot: engine.root,
      changedPaths,
      version,
      frameworkBefore: () => committedSource(engine.root, commits.engine.parent, FRAMEWORK_VERSION_SOURCE, env),
      frameworkAfter: () => committedSource(engine.root, "HEAD", FRAMEWORK_VERSION_SOURCE, env),
      cliReferenceChecked: async () => (await writeResult(process.execPath, [join(engine.root, "scripts", "wiki-cli-reference.mjs"), "--check"], { cwd: engine.root, env, runner })).status === 0,
    }));
  }
  if (commits.helper !== null) {
    committedChangeViolations({ repository: "helper", root: helper.root, parent: commits.helper.parent, recorded: receipt.helper.changes, removeFiles: receipt.helper.removeFiles, env, violations });
    for (const path of sortedPaths(new Set([...receipt.helper.keptFiles, ...receipt.helper.keptExtraFiles]))) {
      const recordedBlob = blobId(helper.root, commits.helper.parent, path, env);
      const committedBlob = blobId(helper.root, "HEAD", path, env);
      if (recordedBlob === null || recordedBlob !== committedBlob) {
        violations.push({ code: "RELEASE_HELPER_KEPT_CHANGED", repository: "helper", path, expected: recordedBlob, actual: committedBlob, message: "a kept helper file must be unchanged by the release commit" });
      }
    }
  }
  const bound = await collect(violations, () => checkReleaseGatePlan({ engineRoot: engine.root, helperRoot: helper.root, workspace, projectRoot, env }));
  if (bound !== undefined && (bound.plan.declarationsDigest !== receipt.gates.declarationsDigest || bound.plan.workspaceId !== receipt.gates.libraryId)) {
    violations.push({ code: "RELEASE_RECEIPT_BASIS_CHANGED", expected: { libraryId: receipt.gates.libraryId, declarationsDigest: receipt.gates.declarationsDigest }, actual: { libraryId: bound.plan.workspaceId, declarationsDigest: bound.plan.declarationsDigest }, message: "the gate library or its declarations changed after generate" });
  }
  const framework = await collect(violations, () => releaseFrameworkVersions(engine.root));
  if (framework !== undefined) {
    for (const [path, actual] of [[FRAMEWORK_VERSION_SOURCE, framework.sourceVersion], [FRAMEWORK_VERSION_BUILT, framework.builtVersion]]) {
      if (actual !== version) violations.push({ code: "RELEASE_VERSION_MISMATCH", path, expected: version, actual: typeof actual === "string" ? actual : null });
    }
  }
  refuseViolations(violations, "the release commits do not match the generate receipt; no gate ran and nothing was packed");

  // TCRN-CROSS-STORY-461 R1 (#232): the repository's own P8 rule moves the source archive and formal
  // package of every other version to dist/stale-release/<version>/ inside the exclusive output
  // session. `pnpm clean` is not used: it deletes dist/build and the gate evidence under
  // dist/evidence (docs/versioning/release-policy.md).
  const { withExclusiveOutputSession } = await import("./safe-io.mjs");
  const { moveStaleReleaseArtifacts, staleReleaseArtifactMoves } = await import("./p8-workflow-rc.mjs");
  const staleReleaseArtifacts = await withExclusiveOutputSession(engine.root, () => moveStaleReleaseArtifacts(engine.root, { version }));
  const gates = await runReleaseGates({ engineRoot: engine.root, helperRoot: helper.root, workspace, projectRoot, env, at });
  const releaseNames = await readdir(join(engine.root, RELEASE_OUTPUT_DIRECTORY)).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  const remaining = staleReleaseArtifactMoves(releaseNames, version);
  if (remaining.length > 0) {
    refuse("RELEASE_STALE_ARTIFACTS_PRESENT", "dist/release holds artifacts of another version before packing", { artifacts: remaining.map((move) => move.from) });
  }
  const assets = await packRelease({ engineRoot: engine.root, version, env, runner });
  const checked = await checkRelease({ engineRoot: engine.root, helperRoot: helper.root, version, env });
  return {
    ok: true,
    reasonCode: "RELEASE_FINISHED",
    version,
    at,
    receipt: location,
    commits,
    commitShape,
    staleReleaseArtifacts,
    gates: gateSummary(gates),
    assets,
    check: checked.reasonCode,
  };
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_./:=+@-]+$/u.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function commandLine(argv) {
  return argv.map(shellQuote).join(" ");
}

function repoPublishInfo(root, env) {
  const branch = git(root, ["branch", "--show-current"], env);
  if (branch === "") refuse("RELEASE_DETACHED_HEAD", `${root} is in a detached HEAD state`, { root });
  const remoteUrl = git(root, ["remote", "get-url", "origin"], env);
  const commit = git(root, ["rev-parse", "HEAD"], env);
  return { root, branch, remote: "origin", remoteUrl, commit };
}

// TCRN-CROSS-STORY-520 (MIN-243 D6, D7): the GitHub Release body is a short description of the
// version and a link to its page in the Wiki's Release Notes chapter, never the CHANGELOG section,
// which stays complete in docs/releases/<version>.md and in the Wiki. The body has three paragraphs:
// the first sentence of RELEASE_SUMMARY, the page's address, and the two attachments. The address is
// composed from the names module when the plan is built, loaded only when needed:
// scripts/lib/privacy.mjs counts an address that continues into a path as a finding, so no source or
// test file carries it as a literal. A page that is missing, empty or not a regular file is refused,
// so that no release links to an empty Wiki page.
const RELEASE_WIKI_NOTES_PAGE = (version) => `Release-Notes-${version}`;

async function releaseWikiNotesAddress(version) {
  const { BRAND, LEGACY_REPOSITORY_NAMES } = await import("./names.mjs");
  return `https://github.com/${LEGACY_REPOSITORY_NAMES.owner}/${BRAND.engine.id}/wiki/${RELEASE_WIKI_NOTES_PAGE(version)}`;
}

async function releaseNotes(engineRoot, version) {
  const path = `docs/wiki/${RELEASE_WIKI_NOTES_PAGE(version)}.md`;
  const target = join(engineRoot, ...path.split("/"));
  const stats = await lstat(target).catch(() => null);
  const page = stats !== null && stats.isFile() ? await readFile(target, "utf8") : "";
  if (page.trim().length === 0) {
    const state = stats === null ? "absent" : stats.isFile() ? "empty" : "not-a-file";
    refuse("RELEASE_WIKI_NOTES_MISSING", `${path} is ${state}; the release body would link to an empty Wiki page`, { version, path, state });
  }
  const summary = RELEASE_SUMMARY(version);
  const headline = /^.*?\.(?=\s|$)/u.exec(summary)?.[0] ?? summary;
  const asset = RELEASE_ASSET(version);
  return `${headline}\n\nRelease notes, by functional module: ${await releaseWikiNotesAddress(version)}\n\nAttachments: \`${asset}\` and its SHA-256 file \`${asset}.sha256\`.\n`;
}

// TCRN-CROSS-MIN-277 D4: the helper repository gets its own GitHub Release for the same tag, with no
// attachments: the skill is the tree at the tag. Its body names the lockstep, links the engine's
// Release and gives the install line; the addresses are composed from the names module, as above.
async function helperReleaseNotes(version) {
  const { BRAND, LEGACY_REPOSITORY_NAMES } = await import("./names.mjs");
  const engineRelease = `https://github.com/${LEGACY_REPOSITORY_NAMES.owner}/${BRAND.engine.id}/releases/tag/v${version}`;
  return `${BRAND.helper.name} ${version} ships in lockstep with ${BRAND.engine.name} ${version}.\n\nEngine release and notes: ${engineRelease}\n\nInstall: \`npx skills add ${LEGACY_REPOSITORY_NAMES.owner}/${BRAND.helper.id}\`\n\nThis release adds no assets; the skill is the tree at tag \`v${version}\`.\n`;
}

export async function buildPublishPlan({ engineRoot, helperRoot, version, wikiDirectory, env = process.env }) {
  const checked = await checkRelease({ engineRoot, helperRoot, version, env });
  const engine = await assertRepository(checked.engine, ENGINE_PACKAGE_NAME, { clean: true, env });
  const helper = await assertRepository(checked.helper, HELPER_PACKAGE_NAME, { clean: true, env });
  const wiki = wikiDirectory === undefined || wikiDirectory === null ? null : resolve(wikiDirectory);
  if (wiki !== null) {
    const wikiStats = await lstat(wiki).catch(() => null);
    if (wikiStats === null || !wikiStats.isDirectory()) refuse("RELEASE_WIKI_DIRECTORY_INVALID", `${wiki} is not an existing directory`, { wikiDirectory: wiki });
  }
  const engineInfo = repoPublishInfo(engine.root, env);
  const helperInfo = repoPublishInfo(helper.root, env);
  const tag = `v${version}`;
  const archive = join(engine.root, RELEASE_OUTPUT_DIRECTORY, RELEASE_ASSET(version));
  const checksum = `${archive}.sha256`;
  await validatePackOutput(engine.root, version);
  const notes = await releaseNotes(engine.root, version);
  const tagCommands = [engineInfo, helperInfo].map(({ root, commit }) => ["git", "-C", root, "tag", "-a", tag, commit, "-m", `Release ${tag}`]);
  const pushCommands = [engineInfo, helperInfo].map(({ root, branch, remote }) => ["git", "-C", root, "push", remote, `HEAD:refs/heads/${branch}`, `refs/tags/${tag}`]);
  const releaseCommand = ["gh", "release", "create", tag, archive, checksum, "--title", `Einzbern ${version}`, "--notes", notes];
  const { BRAND, LEGACY_REPOSITORY_NAMES } = await import("./names.mjs");
  const helperReleaseCommand = ["gh", "release", "create", tag, "--repo", `${LEGACY_REPOSITORY_NAMES.owner}/${BRAND.helper.id}`, "--verify-tag", "--title", `${BRAND.helper.name} ${version}`, "--notes", await helperReleaseNotes(version)];
  const wikiCommand = wiki === null ? null : [process.execPath, join(engine.root, "scripts", "push-wiki.mjs"), "--wiki-dir", wiki, "--execute", "push"];
  const commands = {
    tag: tagCommands,
    push: pushCommands,
    release: releaseCommand,
    helperRelease: helperReleaseCommand,
    wiki: wikiCommand,
  };
  return {
    ok: true,
    reasonCode: "RELEASE_PUBLISH_PLAN_READY",
    version,
    tag,
    repositories: [engineInfo, helperInfo],
    commands,
    printable: {
      tag: tagCommands.map(commandLine),
      push: pushCommands.map(commandLine),
      release: commandLine(releaseCommand),
      helperRelease: commandLine(helperReleaseCommand),
      wiki: wikiCommand === null ? null : commandLine(wikiCommand),
    },
  };
}

function remoteTagExists(root, tag, env) {
  const url = git(root, ["remote", "get-url", "origin"], env);
  const result = run("git", ["ls-remote", "--tags", url, `refs/tags/${tag}`], { cwd: root, env });
  if (result.status !== 0) refuse("RELEASE_REMOTE_CHECK_FAILED", `could not check whether ${tag} exists at origin`, { root, tag, stderr: result.stderr.trim() });
  return result.stdout.trim() !== "";
}

function localTagExists(root, tag, env) {
  return git(root, ["tag", "--list", tag], env) === tag;
}

function executeGit(root, args, env, runner) {
  const result = writeResult("git", ["-C", root, ...args], { cwd: root, env, runner });
  if (result.status !== 0) refuse("RELEASE_ACTION_FAILED", `git ${args.join(" ")} failed in ${root}`, { root, args, stderr: result.stderr.trim() });
  return result.stdout.trim();
}

export async function executeReleaseAction({ action, engineRoot, helperRoot, version, wikiDirectory, env = process.env, runner = null }) {
  if (!RELEASE_ACTIONS.includes(action)) refuse("RELEASE_ACTION_INVALID", `${String(action)} is not a supported release action`, { action: String(action) });
  if (action === "wiki" && !wikiDirectory) refuse("RELEASE_WIKI_DIRECTORY_REQUIRED", "--wiki-dir is required for the Wiki push", {});
  const plan = await buildPublishPlan({ engineRoot, helperRoot, version, wikiDirectory, env });
  const [engineInfo, helperInfo] = plan.repositories;
  const roots = [engineInfo.root, helperInfo.root];
  const tag = plan.tag;

  if (action === "tag") {
    for (const root of roots) {
      if (localTagExists(root, tag, env) || remoteTagExists(root, tag, env)) {
        refuse("RELEASE_TAG_EXISTS", `${tag} already exists locally or at origin`, { root, tag });
      }
    }
    for (const command of plan.commands.tag) executeGit(command[2], command.slice(3), env, runner);
    return { ok: true, reasonCode: "RELEASE_TAGS_CREATED", version, tag, repositories: roots };
  }

  if (action === "push") {
    for (const root of roots) {
      if (!localTagExists(root, tag, env)) refuse("RELEASE_TAG_MISSING", `${tag} must be created in both repositories before push`, { root, tag });
    }
    const pushed = [];
    for (const info of [engineInfo, helperInfo]) {
      executeGit(info.root, ["push", info.remote, `HEAD:refs/heads/${info.branch}`, `refs/tags/${tag}`], env, runner);
      pushed.push({ root: info.root, branch: info.branch, tag });
    }
    return { ok: true, reasonCode: "RELEASE_PUSHED", version, pushed };
  }

  if (action === "release") {
    for (const root of roots) {
      if (!localTagExists(root, tag, env) || !remoteTagExists(root, tag, env)) {
        refuse("RELEASE_TAG_NOT_PUBLISHED", `${tag} must exist at origin in both repositories before GitHub release`, { root, tag });
      }
    }
    const command = plan.commands.release;
    const result = writeResult(command[0], command.slice(1), { cwd: engineInfo.root, env, runner });
    if (result.status !== 0) refuse("RELEASE_ACTION_FAILED", "gh release create failed", { stderr: result.stderr.trim(), stdout: result.stdout.trim() });
    // The engine's Release is created first; a helper Release that fails after it is reported with the
    // engine's output, so the caller can create the helper's alone from printable.helperRelease.
    const helperCommand = plan.commands.helperRelease;
    const helperResult = writeResult(helperCommand[0], helperCommand.slice(1), { cwd: helperInfo.root, env, runner });
    if (helperResult.status !== 0) {
      refuse("RELEASE_HELPER_ACTION_FAILED", "gh release create failed for the helper repository after the engine's Release was created", { engineOutput: result.stdout.trim(), stderr: helperResult.stderr.trim(), stdout: helperResult.stdout.trim() });
    }
    return { ok: true, reasonCode: "RELEASE_PUBLISHED", version, tag, archive: command[4], checksum: command[5], output: result.stdout.trim(), helperOutput: helperResult.stdout.trim() };
  }

  const command = plan.commands.wiki;
  const result = writeResult(command[0], command.slice(1), { cwd: engineInfo.root, env, runner });
  if (result.status !== 0) refuse("RELEASE_ACTION_FAILED", "push-wiki rehearsal and push failed", { stderr: result.stderr.trim(), stdout: result.stdout.trim() });
  const report = parseCommandJson(result, "push-wiki --execute push");
  if (report.pushed !== true && report.reasonCode !== "WIKI_UP_TO_DATE") {
    refuse("RELEASE_ACTION_FAILED", "push-wiki did not report a completed push", { report });
  }
  return { ok: true, reasonCode: "RELEASE_WIKI_PUSHED", version, report };
}
