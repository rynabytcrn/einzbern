// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-488 R1, R2, R4 (TCRN-CROSS-SUB-355): verify the two-repository version lock,
// local release preparation, all-red stop, and explicit tag/push/release execution in scratch.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";

import {
  ReleaseLockstepError,
  buildPublishPlan,
  checkRelease,
  executeReleaseAction,
  checkReleaseGatePlan,
  assertReleaseGateRun,
  prepareRelease,
  runReleaseGates,
} from "../scripts/lib/release-lockstep.mjs";
import { README_NAMES, renderReadmes } from "../scripts/render-readme.mjs";
import { FRAMEWORK_VERSION, initializeLibrary } from "../dist/build/packages/core/src/index.js";
import { registerLibrary } from "../dist/build/packages/core/src/registry.js";
import { setGate } from "../dist/build/packages/core/src/gates-config.js";
import { gateTreeState } from "../dist/build/packages/core/src/gates-run.js";
import { stripTypesWithScopedExperimentalWarning } from "../scripts/lib/scoped-strip-types.mjs";

const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-release-lockstep-")));
const OLD_VERSION = FRAMEWORK_VERSION;
const HELPER_OLD_VERSION = "1.0.7";
const NEXT_VERSION = OLD_VERSION === "2.0.0" ? "2.0.1" : "2.0.0";
const FIXTURE_SCHEMA_VERSION = "tcrn.fixture-contract.v1";
const HELPER_READMES = ["README.md", "README.en.md", "README.ja.md", "README.ko.md", "README.fr.md"];
const RELEASE_NOTES = "Einzbern renamed TCRN Workflow and Mana Orchestrate replaced tcrn-workflow-helper. The previous commands are retired.";
const RELEASE_CLI = fileURLToPath(new URL("../scripts/release.mjs", import.meta.url));
const REPOSITORY_ROOT = dirname(dirname(RELEASE_CLI));
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
  for (const path of ["LICENSE", "NOTICE", "packages/core/src/names.ts"]) {
    await writeText(engineRoot, path, await readFile(join(REPOSITORY_ROOT, path), "utf8"));
  }
  await writeText(engineRoot, "packages/core/src/index.ts", await readFile(join(REPOSITORY_ROOT, "packages/core/src/index.ts"), "utf8"));
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

async function makeEnvironment(name) {
  const home = join(base, name, "home");
  const einZbernHome = join(home, ".einzbern");
  await mkdir(einZbernHome, { recursive: true });
  return { ...process.env, HOME: home, EINZBERN_HOME: einZbernHome };
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

async function controlledPrepareRunner({ engineRoot, helperRoot, projectRoot, environment, workspace, staleBuild = false }) {
  const calls = [];
  const runner = async (command, args, { cwd, env }) => {
    calls.push({ command, args, cwd });
    if (command === "corepack") {
      if (!staleBuild) {
        const source = await readFile(join(engineRoot, "packages/core/src/index.ts"), "utf8");
        await writeText(engineRoot, "dist/build/packages/core/src/index.js", stripTypesWithScopedExperimentalWarning(source, { mode: "transform", sourceMap: false }));
      }
      return { status: 0, stdout: '{"ok":true,"reasonCode":"BUILD_VERIFIED"}\n', stderr: "" };
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
  assert.match(changelog, /TCRN Workflow and tcrn-workflow-helper release names are retired/u);
  assert.match(changelog, /retired surfaces/iu);
  const archive = await readFile(result.assets.archive);
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
  const sourcePath = join(repos.engineRoot, "packages/core/src/index.ts");
  const preparedSource = await readFile(sourcePath, "utf8");
  await writeFile(sourcePath, preparedSource.replace(`FRAMEWORK_VERSION = "${NEXT_VERSION}"`, `FRAMEWORK_VERSION = "${OLD_VERSION}"`));
  await assert.rejects(checkRelease({ ...repos, version: NEXT_VERSION, env: environment }), (error) => error.reasonCode === "RELEASE_VERSION_MISMATCH" && error.details.mismatches.some((entry) => entry.path === "packages/core/src/index.ts"));
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
      const source = await readFile(join(repos.engineRoot, "packages/core/src/index.ts"), "utf8");
      await writeText(repos.engineRoot, "dist/build/packages/core/src/index.js", stripTypesWithScopedExperimentalWarning(source, { mode: "transform", sourceMap: false }));
      return { status: 0, stdout: '{"ok":true}\n', stderr: "" };
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
  const plan = await buildPublishPlan({ ...repos, version: NEXT_VERSION, wikiDirectory, env: environment });
  assert.equal(plan.reasonCode, "RELEASE_PUBLISH_PLAN_READY");
  assert.deepEqual(plan.commands.tag.map((args) => args.at(-1)), [`v${NEXT_VERSION}`, `v${NEXT_VERSION}`]);
  assert.ok(plan.commands.push.every((args) => args.includes("push")));
  assert.ok(plan.commands.release.includes(join(repos.engineRoot, `dist/release/einzbern-${NEXT_VERSION}.tar.gz`)));
  assert.ok(plan.commands.release.includes(join(repos.engineRoot, `dist/release/einzbern-${NEXT_VERSION}.tar.gz.sha256`)));
  assert.match(plan.printable.wiki, /push-wiki\.mjs.*--execute push/u);
  assert.equal(git(repos.engineRoot, ["tag", "--list", `v${NEXT_VERSION}`]), "");
  assert.equal(git(repos.helperRoot, ["tag", "--list", `v${NEXT_VERSION}`]), "");

  const tag = await executeReleaseAction({ action: "tag", ...repos, version: NEXT_VERSION, env: environment });
  assert.equal(tag.reasonCode, "RELEASE_TAGS_CREATED");
  assert.equal(git(repos.engineRoot, ["tag", "--list", `v${NEXT_VERSION}`]), `v${NEXT_VERSION}`);
  assert.equal(git(repos.helperRoot, ["tag", "--list", `v${NEXT_VERSION}`]), `v${NEXT_VERSION}`);
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

  const bin = join(base, "fake-gh-bin");
  const home = join(base, "publish", "home");
  await mkdir(bin, { recursive: true });
  const capture = join(base, "fake-gh-args.json");
  const fakeGh = join(bin, "gh");
  await writeFile(fakeGh, "#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.GH_CAPTURE, JSON.stringify(process.argv.slice(2)));\n");
  await chmod(fakeGh, 0o755);
  const releaseEnvironment = { ...environment, HOME: home, EINZBERN_HOME: join(home, ".einzbern"), GH_CAPTURE: capture, PATH: `${bin}:${process.env.PATH ?? ""}` };
  await mkdir(releaseEnvironment.EINZBERN_HOME, { recursive: true });
  const released = await executeReleaseAction({ action: "release", ...repos, version: NEXT_VERSION, env: releaseEnvironment });
  assert.equal(released.reasonCode, "RELEASE_PUBLISHED");
  const ghArgs = JSON.parse(await readFile(capture, "utf8"));
  assert.equal(ghArgs[0], "release");
  assert.equal(ghArgs[1], "create");
  assert.equal(ghArgs[2], `v${NEXT_VERSION}`);
  assert.ok(ghArgs.includes(join(repos.engineRoot, `dist/release/einzbern-${NEXT_VERSION}.tar.gz`)));
  assert.ok(ghArgs.includes(join(repos.engineRoot, `dist/release/einzbern-${NEXT_VERSION}.tar.gz.sha256`)));
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
  await assert.rejects(controlledPrepareRunner({ ...repos, environment, workspace, staleBuild: true }), (error) => error.reasonCode === "RELEASE_VERSION_MISMATCH" && error.details.mismatches.some((entry) => entry.path === "dist/build/packages/core/src/index.js"));
});
