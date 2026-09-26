// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { README_NAMES, renderReadmes } from "../render-readme.mjs";

export const RELEASE_ACTIONS = Object.freeze(["tag", "push", "release", "wiki"]);
export const RELEASE_VERSION_SHAPE = /^\d+\.\d+\.\d+$/u;
export const ENGINE_PACKAGE_NAME = "einzbern";
export const HELPER_PACKAGE_NAME = "mana-orchestrate";
export const CHANGELOG_FILE = "CHANGELOG.md";
export const RELEASE_OUTPUT_DIRECTORY = "dist/release";

const HELPER_README_NAMES = Object.freeze(["README.md", "README.en.md", "README.ja.md", "README.ko.md", "README.fr.md"]);
const RELEASE_ASSET = (version) => `${ENGINE_PACKAGE_NAME}-${version}.tar.gz`;
const RELEASE_SUMMARY = (version) => `Einzbern and Mana Orchestrate ship in lockstep at ${version}. The former TCRN Workflow and tcrn-workflow-helper release names are retired; previously written TCRN keys and tcrn.* records remain historical compatibility identifiers. Retired surfaces are listed below.`;

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
  const hasEngineRename = section.includes("Einzbern");
  const hasHelperRename = section.includes("Mana Orchestrate");
  const hasDeprecatedNames = section.includes("tcrn-workflow-helper") && /TCRN Workflow/iu.test(section);
  const hasRetiredItems = /(retired|retire|deprecated|deprecation|停用|退役|移除|删除)/iu.test(section);
  if (!hasEngineRename || !hasHelperRename || !hasDeprecatedNames || !hasRetiredItems) {
    mismatches.push({
      path: CHANGELOG_FILE,
      expected: "release section naming both renamed projects and retired surfaces",
      actual: "release section is missing required rename or retirement notes",
    });
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

function run(command, args, { cwd, env = process.env } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) return { status: 1, stdout: result.stdout ?? "", stderr: String(result.error) };
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function git(root, args, env = process.env) {
  const result = run("git", ["-C", root, ...args], { cwd: root, env });
  if (result.status !== 0) {
    refuse("RELEASE_GIT_FAILED", `git ${args.join(" ")} failed in ${root}`, { root, args, stderr: result.stderr.trim() });
  }
  return result.stdout.trim();
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

export async function checkRelease({ engineRoot, helperRoot, version, env = process.env }) {
  if (typeof version !== "string" || !RELEASE_VERSION_SHAPE.test(version)) {
    refuse("RELEASE_VERSION_INVALID", `${String(version)} is not a stable release version`, { version: String(version) });
  }
  const engine = await assertRepository(engineRoot, ENGINE_PACKAGE_NAME, { env });
  const helper = await assertRepository(helperRoot, HELPER_PACKAGE_NAME, { env });
  ensureSeparateRepositories(engine.root, helper.root);

  const mismatches = [];
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

export async function prepareRelease({ engineRoot, helperRoot, version, workspace = null, env = process.env, runner = null, at = utcNow() }) {
  if (typeof version !== "string" || !RELEASE_VERSION_SHAPE.test(version)) {
    refuse("RELEASE_VERSION_INVALID", `${String(version)} is not a stable release version`, { version: String(version) });
  }
  if (workspace === null || workspace === undefined || String(workspace).length === 0) {
    refuse("RELEASE_WORKSPACE_REQUIRED", "prepare needs a library path for gates-run --release", {});
  }
  const engine = await assertRepository(engineRoot, ENGINE_PACKAGE_NAME, { clean: true, env });
  const helper = await assertRepository(helperRoot, HELPER_PACKAGE_NAME, { clean: true, env });
  ensureSeparateRepositories(engine.root, helper.root);

  const packagePaths = [join(engine.root, "package.json"), ...await enginePackagePaths(engine.root)];
  const sourceVersions = [];
  for (const path of packagePaths) {
    const manifest = await readJson(path);
    if (typeof manifest.version !== "string" || !RELEASE_VERSION_SHAPE.test(manifest.version)) {
      refuse("RELEASE_VERSION_INVALID", `${path} does not contain a stable version`, { path, version: manifest.version ?? null });
    }
    sourceVersions.push({ path: path.slice(engine.root.length + 1), version: manifest.version });
  }
  const currentVersions = new Set(sourceVersions.map((entry) => entry.version));
  if (currentVersions.size !== 1) {
    refuse("RELEASE_VERSION_MISMATCH", "engine package versions disagree before prepare", { mismatches: sourceVersions });
  }
  const changelogPath = join(engine.root, CHANGELOG_FILE);
  const changelog = await readFile(changelogPath, "utf8").catch((error) => {
    refuse("RELEASE_FILE_MISSING", `${CHANGELOG_FILE} does not exist`, { path: CHANGELOG_FILE, code: error?.code ?? "UNKNOWN" });
  });
  const nextChangelog = changelogForPrepare(changelog, version);
  for (const path of packagePaths) await updatePackageVersion(path, version);
  await writeFile(changelogPath, nextChangelog);

  const build = parseCommandJson(await writeResult("corepack", ["pnpm@11.3.0", "--dir", engine.root, "run", "build"], { cwd: engine.root, env, runner }), "build");
  if (build.ok === false) refuse("RELEASE_BUILD_FAILED", "the release build reported failure", { build });

  const readme = parseCommandJson(await writeResult(process.execPath, [join(engine.root, "scripts", "render-readme.mjs"), "--version", version], { cwd: engine.root, env, runner }), "render-readme");
  if (readme.ok === false) refuse("RELEASE_README_RENDER_FAILED", "render-readme reported drift or failure", { readme });

  const helperDocs = parseCommandJson(await writeResult(process.execPath, [join(engine.root, "scripts", "render-helper-docs.mjs"), "--out", helper.root, "--version", version], { cwd: engine.root, env, runner }), "render-helper-docs");
  if (helperDocs.ok === false || helperDocs.reasonCode !== "HELPER_DOCS_RENDERED") {
    refuse("RELEASE_HELPER_RENDER_FAILED", "render-helper-docs did not complete", { helperDocs });
  }

  const gateArgs = [join(engine.root, "scripts", "einzbern.mjs"), "gates-run", "--release", "--at", at];
  if (workspace !== null) gateArgs.push("--workspace", resolve(workspace));
  const gates = parseCommandJson(await writeResult(process.execPath, gateArgs, { cwd: engine.root, env, runner }), "gates-run --release");
  if (gates.ok !== true || (Array.isArray(gates.reds) && gates.reds.length > 0) || (Array.isArray(gates.requiredReds) && gates.requiredReds.length > 0)) {
    refuse("RELEASE_GATES_RED", "release gates reported one or more red results", { gates });
  }

  const pack = parseCommandJson(await writeResult(process.execPath, [join(engine.root, "scripts", "pack-release.mjs"), "--version", version], { cwd: engine.root, env, runner }), "pack-release");
  if (pack.ok === false || pack.reasonCode !== "RELEASE_PACKED") refuse("RELEASE_PACK_FAILED", "pack-release did not complete", { pack });
  const assets = await validatePackOutput(engine.root, version);
  const checked = await checkRelease({ engineRoot: engine.root, helperRoot: helper.root, version, env });
  return {
    ok: true,
    reasonCode: "RELEASE_PREPARED",
    version,
    at,
    gates: { reasonCode: gates.reasonCode, ok: gates.ok, reds: gates.reds ?? [] },
    assets,
    check: checked.reasonCode,
    helperExtraFiles: helperDocs.extraFiles ?? [],
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
  return { root, branch, remote: "origin", remoteUrl };
}

function releaseNotes(changelog, version) {
  const section = changelogSection(changelog, version);
  if (section === null) refuse("RELEASE_CHANGELOG_VERSION_MISSING", `CHANGELOG.md has no ${version} section`, { version });
  return section;
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
  const notes = releaseNotes(await readFile(join(engine.root, CHANGELOG_FILE), "utf8"), version);
  const tagCommands = [engineInfo, helperInfo].map(({ root }) => ["git", "-C", root, "tag", tag]);
  const pushCommands = [engineInfo, helperInfo].map(({ root, branch, remote }) => ["git", "-C", root, "push", remote, `HEAD:refs/heads/${branch}`, `refs/tags/${tag}`]);
  const releaseCommand = ["gh", "release", "create", tag, archive, checksum, "--title", `Einzbern ${version}`, "--notes", notes];
  const wikiCommand = wiki === null ? null : [process.execPath, join(engine.root, "scripts", "push-wiki.mjs"), "--wiki-dir", wiki, "--execute", "push"];
  const commands = {
    tag: tagCommands,
    push: pushCommands,
    release: releaseCommand,
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
    for (const root of roots) executeGit(root, ["tag", tag], env, runner);
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
    return { ok: true, reasonCode: "RELEASE_PUBLISHED", version, tag, archive: command[4], checksum: command[5], output: result.stdout.trim() };
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
