// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-488 R1, R2, R4 (TCRN-CROSS-SUB-355): verify the two-repository version lock,
// local release preparation, all-red stop, and explicit tag/push/release execution in scratch.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import {
  ReleaseLockstepError,
  buildPublishPlan,
  checkRelease,
  executeReleaseAction,
  prepareRelease,
} from "../scripts/lib/release-lockstep.mjs";
import { README_NAMES, renderReadmes } from "../scripts/render-readme.mjs";

const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-release-lockstep-")));
const OLD_VERSION = "1.2.1";
const HELPER_OLD_VERSION = "1.0.7";
const NEXT_VERSION = "2.0.0";
const HELPER_READMES = ["README.md", "README.en.md", "README.ja.md", "README.ko.md", "README.fr.md"];
const RELEASE_NOTES = "Einzbern renamed TCRN Workflow and Mana Orchestrate replaced tcrn-workflow-helper. The previous commands are retired.";
const RELEASE_CLI = fileURLToPath(new URL("../scripts/release.mjs", import.meta.url));
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

  await writeText(engineRoot, "package.json", `${JSON.stringify({ name: "einzbern", version: OLD_VERSION, private: true }, null, 2)}\n`);
  for (const packageName of ["cli", "core", "protocol"]) {
    await writeText(engineRoot, `packages/${packageName}/package.json`, `${JSON.stringify({ name: `@einzbern/${packageName}`, version: OLD_VERSION, private: true }, null, 2)}\n`);
  }
  await writeText(engineRoot, ".gitignore", "/dist/\n");
  await writeText(engineRoot, "CHANGELOG.md", `# Changelog\n\n## Unreleased\n\n${RELEASE_NOTES}\n\n## 1.2.1\n\nEarlier release.\n`);
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
  return { engineRoot: await realpath(engineRoot), helperRoot: await realpath(helperRoot) };
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

async function makeWorkspace(name) {
  const workspace = join(base, name, "release-workspace");
  await mkdir(workspace, { recursive: true });
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
    ["prepare", "--version", NEXT_VERSION, "--helper", join(base, "missing-helper")],
    "RELEASE_ARGUMENT_MISSING",
  );
  assertCliReason(
    ["--version", NEXT_VERSION, "--helper", join(base, "missing-helper"), "--execute", "tag"],
    "RELEASE_REPOSITORY_INVALID",
  );
});

async function fakePrepareRunner({ engineRoot, helperRoot, environment, workspace, gateReds = [] }) {
  const calls = [];
  const runner = async (command, args, { cwd, env }) => {
    calls.push({ command, args, cwd });
    if (command === "corepack") return { status: 0, stdout: '{"ok":true,"reasonCode":"BUILD_VERIFIED"}\n', stderr: "" };
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
    if (scriptName === "einzbern.mjs") {
      assert.ok(args.includes("gates-run"));
      assert.ok(args.includes("--release"));
      assert.ok(args.includes("--at"));
      return { status: 0, stdout: `${JSON.stringify({ ok: gateReds.length === 0, reasonCode: "GATES_RUN_COMPLETED", reds: gateReds, requiredReds: gateReds })}\n`, stderr: "" };
    }
    if (scriptName === "pack-release.mjs") {
      const version = args[args.indexOf("--version") + 1];
      const archiveName = `einzbern-${version}.tar.gz`;
      const archive = Buffer.from(`release:${version}`);
      const sha256 = createHash("sha256").update(archive).digest("hex");
      await writeText(engineRoot, `dist/release/${archiveName}`, archive);
      await writeText(engineRoot, `dist/release/${archiveName}.sha256`, `${sha256}  ${archiveName}\n`);
      return { status: 0, stdout: `${JSON.stringify({ ok: true, reasonCode: "RELEASE_PACKED", version, sha256 })}\n`, stderr: "" };
    }
    throw new Error(`unexpected command ${command} ${args.join(" ")} in ${cwd}; HOME=${env.HOME}; EINZBERN_HOME=${env.EINZBERN_HOME}`);
  };
  const result = await prepareRelease({
    engineRoot,
    helperRoot,
    version: NEXT_VERSION,
    workspace,
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

test("488-R1/R2/R4: prepare aligns both repositories, runs release gates before packing, and writes the matching checksum", async () => {
  const repos = await createRepos("prepare");
  const environment = await makeEnvironment("prepare");
  const workspace = await makeWorkspace("prepare");
  const { result, calls } = await fakePrepareRunner({ ...repos, environment, workspace });
  assert.equal(result.reasonCode, "RELEASE_PREPARED");
  assert.equal(result.version, NEXT_VERSION);
  assert.equal(result.gates.ok, true);
  assert.deepEqual(result.helperExtraFiles, []);
  const check = await checkRelease({ ...repos, version: NEXT_VERSION, env: environment });
  assert.equal(check.reasonCode, "RELEASE_VERSION_CHECKED");
  assert.equal(JSON.parse(await readFile(join(repos.engineRoot, "packages/core/package.json"), "utf8")).version, NEXT_VERSION);
  assert.equal(JSON.parse(await readFile(join(repos.helperRoot, "package.json"), "utf8")).version, NEXT_VERSION);
  const changelog = await readFile(join(repos.engineRoot, "CHANGELOG.md"), "utf8");
  assert.match(changelog, new RegExp(`^## ${NEXT_VERSION}$`, "mu"));
  assert.match(changelog, /TCRN Workflow and tcrn-workflow-helper release names are retired/u);
  assert.match(changelog, /retired surfaces/iu);
  const archive = await readFile(result.assets.archive);
  const checksum = await readFile(result.assets.checksum, "utf8");
  assert.equal(checksum, `${createHash("sha256").update(archive).digest("hex")}  einzbern-${NEXT_VERSION}.tar.gz\n`);
  const gateIndex = calls.findIndex((call) => call.args.includes("gates-run"));
  const packIndex = calls.findIndex((call) => call.args[0]?.endsWith("pack-release.mjs"));
  assert.ok(gateIndex >= 0 && packIndex > gateIndex, "pack-release runs only after every release gate passes");
  assert.ok(calls[gateIndex].args.includes(workspace), "release gates run against the explicitly named library");
  assert.equal(calls.some((call) => call.command === "gh" || call.args.includes("tag") || call.args.includes("push")), false);
});

test("488-R4: a red release gate stops preparation before the archive step", async () => {
  const repos = await createRepos("gate-red");
  const environment = await makeEnvironment("gate-red");
  const workspace = await makeWorkspace("gate-red");
  const calls = [];
  const runner = async (command, args, options) => {
    calls.push({ command, args });
    const scriptName = args[0]?.split("/").at(-1);
    if (command === "corepack") return { status: 0, stdout: '{"ok":true}\n', stderr: "" };
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
    if (scriptName === "einzbern.mjs") return { status: 0, stdout: '{"ok":false,"reasonCode":"GATES_RUN_COMPLETED","reds":[{"name":"required","ok":false}],"requiredReds":[{"name":"required","ok":false}]}\n', stderr: "" };
    throw new Error(`unexpected command: ${command} ${args.join(" ")} ${options.cwd}`);
  };
  await assert.rejects(
    prepareRelease({ ...repos, version: NEXT_VERSION, workspace, env: environment, runner }),
    (error) => error.reasonCode === "RELEASE_GATES_RED",
  );
  assert.equal(calls.some((call) => call.args[0]?.endsWith("pack-release.mjs")), false);
});

test("488-AC1/AC2: the publish plan is inert; tag, push and GitHub release each need an explicit action", async () => {
  const repos = await createRepos("publish");
  await createOrigin(repos.engineRoot, "publish-engine-origin");
  await createOrigin(repos.helperRoot, "publish-helper-origin");
  const environment = await makeEnvironment("publish");
  const workspace = await makeWorkspace("publish");
  await fakePrepareRunner({ ...repos, environment, workspace });
  await commitAll(repos.engineRoot, "prepare engine release");
  await commitAll(repos.helperRoot, "prepare helper release");
  const wikiDirectory = join(base, "publish-wiki");
  await mkdir(wikiDirectory, { recursive: true });
  const plan = await buildPublishPlan({ ...repos, version: NEXT_VERSION, wikiDirectory, env: environment });
  assert.equal(plan.reasonCode, "RELEASE_PUBLISH_PLAN_READY");
  assert.deepEqual(plan.commands.tag.map((args) => args.at(-1)), [`v${NEXT_VERSION}`, `v${NEXT_VERSION}`]);
  assert.ok(plan.commands.push.every((args) => args.includes("push")));
  assert.ok(plan.commands.release.includes(join(repos.engineRoot, "dist/release/einzbern-2.0.0.tar.gz")));
  assert.ok(plan.commands.release.includes(join(repos.engineRoot, "dist/release/einzbern-2.0.0.tar.gz.sha256")));
  assert.match(plan.printable.wiki, /push-wiki\.mjs.*--execute push/u);
  assert.equal(git(repos.engineRoot, ["tag", "--list", `v${NEXT_VERSION}`]), "");
  assert.equal(git(repos.helperRoot, ["tag", "--list", `v${NEXT_VERSION}`]), "");

  const tag = await executeReleaseAction({ action: "tag", ...repos, version: NEXT_VERSION, env: environment });
  assert.equal(tag.reasonCode, "RELEASE_TAGS_CREATED");
  assert.equal(git(repos.engineRoot, ["tag", "--list", `v${NEXT_VERSION}`]), `v${NEXT_VERSION}`);
  assert.equal(git(repos.helperRoot, ["tag", "--list", `v${NEXT_VERSION}`]), `v${NEXT_VERSION}`);

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
  assert.ok(ghArgs.includes(join(repos.engineRoot, "dist/release/einzbern-2.0.0.tar.gz")));
  assert.ok(ghArgs.includes(join(repos.engineRoot, "dist/release/einzbern-2.0.0.tar.gz.sha256")));
});
