// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-477 R1, R3, R5: host-render renders Einzbern's one hook into a host's own files,
// at the user's level or a project's (packages/core/src/host-hooks.ts). The dispatch projection it
// used to write (models, efforts, agent files) and the CLAUDE.md bridge are gone.
// TCRN-CROSS-STORY-470 R5: its writable-roots scope names a library outside the project.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { renderHostHooks, renderWritableRoots } from "../scripts/host-render.mjs";
import { runCli } from "../dist/build/packages/cli/src/index.js";
import { MACHINE_SETTINGS_FILE_NAME, applyMachineSettingSet } from "../dist/build/packages/core/src/machine-settings.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(repoRoot, "scripts", "host-render.mjs");
const AT = "2026-09-26T10:00:00Z";

async function scratchFor(t, prefix) {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

// A home and a device directory of the test's own, never the real ones.
async function machine(t, prefix) {
  const base = await scratchFor(t, prefix);
  const home = join(base, "home");
  const device = join(base, "device");
  await mkdir(home);
  return { base, home, device, env: { ...process.env, HOME: home, EINZBERN_HOME: device } };
}

function run(args, env) {
  return JSON.parse(execFileSync(process.execPath, [cli, ...args], { encoding: "utf8", env }));
}

function refusal(args, env) {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env });
  assert.equal(result.status, 1, args.join(" "));
  return JSON.parse(result.stderr.trim().split("\n").at(-1)).reasonCode;
}

function oneHook(device, host = "claude-code") {
  return Object.fromEntries([["UserPromptSubmit", "user-prompt-submit"], ["SubagentStart", "subagent-start"], ["PreToolUse", "pre-tool-use"], ...(host === "codex" ? [["SubagentStop", "subagent-stop"]] : [])].map(([event, word]) => [event, [{ hooks: [{ type: "command", command: `node "${join(device, "engine", "hook.mjs")}" ${word}` }] }]]));
}

test("BL34/35: --scope user renders the exact host-specific engine hooks into the home directory", async (t) => {
  const { home, device, env } = await machine(t, "einzbern-host-render-user-");
  for (const host of ["claude-code", "codex"]) {
    const plan = run(["--host", host, "--scope", "user", "--plan-only"], env);
    assert.deepEqual([plan.reasonCode, plan.scope, plan.host, plan.root], ["HOST_RENDER_PLAN_READY", "user", host, home]);
    assert.ok(plan.files.every((file) => file.beforeSha256 === null && file.changed));
  }
  assert.deepEqual(await readdir(home), [], "a plan writes nothing");

  for (const host of ["claude-code", "codex"]) {
    const receipt = run(["--host", host, "--scope", "user", "--at", AT], env);
    assert.deepEqual([receipt.reasonCode, receipt.wrote, receipt.backupDir], ["HOST_RENDER_COMMITTED", true, null]);
    assert.equal(receipt.command, oneHook(device).UserPromptSubmit[0].hooks[0].command);
  }
  assert.deepEqual(JSON.parse(await readFile(join(home, ".claude", "settings.json"), "utf8")), { hooks: oneHook(device) });
  assert.deepEqual(JSON.parse(await readFile(join(home, ".codex", "hooks.json"), "utf8")), { hooks: oneHook(device, "codex") });
  assert.equal(await readFile(join(home, ".codex", "config.toml"), "utf8"), "[features]\nhooks = true\n");
  assert.deepEqual((await readdir(home)).sort(), [".claude", ".codex"]);
  assert.deepEqual(await readdir(join(home, ".claude")), ["settings.json"], "no agent files, no CLAUDE.md bridge");

  for (const host of ["claude-code", "codex"]) {
    const again = run(["--host", host, "--scope", "user", "--at", AT], env);
    assert.deepEqual([again.reasonCode, again.wrote], ["HOST_RENDER_ALREADY_CURRENT", false], `${host}: rendering again changes nothing`);
  }
});

test("478-AC5: --scope user renders pointer hooks when this device declined the navigation section", async (t) => {
  const { home, device, env } = await machine(t, "einzbern-host-render-declined-navigation-");
  await applyMachineSettingSet({
    key: "agents.navigation",
    value: "declined",
    occurredAt: AT,
    path: join(device, MACHINE_SETTINGS_FILE_NAME),
  });

  const receipt = run(["--host", "claude-code", "--scope", "user", "--at", AT], env);
  assert.equal(receipt.reasonCode, "HOST_RENDER_COMMITTED");
  const hooks = JSON.parse(await readFile(join(home, ".claude", "settings.json"), "utf8")).hooks;
  assert.deepEqual(Object.keys(hooks).sort(), ["PreToolUse", "SessionStart", "SubagentStart", "UserPromptSubmit"]);
  assert.match(hooks.SessionStart[0].hooks[0].command, / session-start$/u);
  assert.match(hooks.SubagentStart[0].hooks[0].command, / subagent-start$/u);
});

test("477-R1, R3: --scope project renders the hook into the project and leaves the model, the effort and every other setting alone", async (t) => {
  const { base, home, device, env } = await machine(t, "einzbern-host-render-project-");
  const project = join(base, "project");
  await mkdir(join(project, ".claude"), { recursive: true });
  const before = {
    model: "user-model",
    env: { CLAUDE_CODE_EFFORT_LEVEL: "user-effort", KEEP: "1" },
    permissions: { allow: ["Read(/**)"] },
    hooks: { Stop: [{ hooks: [{ type: "command", command: "echo user-stop" }] }] },
  };
  await writeFile(join(project, ".claude", "settings.json"), `${JSON.stringify(before, null, 2)}\n`);
  for (const host of ["claude-code", "codex"]) {
    const receipt = run(["--host", host, "--scope", "project", "--root", project, "--at", AT], env);
    assert.deepEqual([receipt.reasonCode, receipt.root], ["HOST_RENDER_COMMITTED", project]);
  }
  assert.deepEqual(JSON.parse(await readFile(join(project, ".claude", "settings.json"), "utf8")), { ...before, hooks: { ...before.hooks, ...oneHook(device) } });
  assert.deepEqual(JSON.parse(await readFile(join(project, ".codex", "hooks.json"), "utf8")), { hooks: oneHook(device, "codex") });
  assert.deepEqual((await readdir(project)).sort(), [".claude", ".codex"], "no CLAUDE.md");
  assert.deepEqual((await readdir(join(project, ".claude"))).sort(), ["settings.json"], "no agent files");
  assert.deepEqual(await readdir(join(project, ".codex")), ["hooks.json"], "Codex's config.toml is the user's");
  assert.equal(await readFile(join(home, ".codex", "config.toml"), "utf8"), "[features]\nhooks = true\n");
  // The replaced settings file went to the device directory first.
  const [root] = await readdir(join(device, "backups", "20260926T100000Z", "host-hooks"));
  assert.deepEqual(JSON.parse(await readFile(join(device, "backups", "20260926T100000Z", "host-hooks", root, ".claude", "settings.json"), "utf8")), before);
});

test("477-R5: the rendering for Windows writes a quoted backslash path with nothing a shell would read", async (t) => {
  const { home } = await machine(t, "einzbern-host-render-win32-");
  const plan = await renderHostHooks({ host: "codex", scope: "user", home, device: "D:\\Einzbern\\device", platform: "win32", planOnly: true });
  assert.equal(plan.command, 'node "D:\\Einzbern\\device\\engine\\hook.mjs" user-prompt-submit');
  assert.deepEqual(await readdir(home), []);
});

test("477-R1: host-render refuses the retired dispatch arguments, an unknown scope and a missing root before writing anything", async (t) => {
  const { base, home, env } = await machine(t, "einzbern-host-render-refusals-");
  const project = join(base, "project");
  await mkdir(project);
  for (const retired of [["--workspace", project], ["--settings", "[]"], ["--mode", "frontier"], ["--repo-root", project], ["--hooks-only"], ["--backup-dir", project]]) {
    assert.equal(refusal(["--host", "codex", "--scope", "user", ...retired], env), "HOST_RENDER_ARGUMENT_UNKNOWN", retired[0]);
  }
  assert.equal(refusal(["--host", "codex", "--root", project, "--scope", "full"], env), "HOST_RENDER_SCOPE_INVALID");
  assert.equal(refusal(["--host", "codex", "--root", project, "--scope", "hooks-only"], env), "HOST_RENDER_SCOPE_INVALID");
  assert.equal(refusal(["--host", "codex", "--scope", "project"], env), "HOST_RENDER_ARGUMENT_MISSING");
  assert.equal(refusal(["--host", "codex", "--root", project], env), "HOST_RENDER_ARGUMENT_MISSING");
  assert.equal(refusal(["--host", "codex", "--scope", "user", "--root", project], env), "HOST_RENDER_SCOPE_CONFLICT");
  assert.equal(refusal(["--host", "codex", "--scope", "user", "--scope", "user"], env), "HOST_RENDER_ARGUMENT_DUPLICATE");
  assert.equal(refusal(["--host", "cursor", "--scope", "user"], env), "HOST_RENDER_HOST_UNKNOWN");
  assert.equal(refusal(["--host", "codex", "--scope", "user", "--at", "yesterday"], env), "TIMESTAMP_INVALID");
  assert.deepEqual(await readdir(home), [], "no refused run wrote anything");
  assert.deepEqual(await readdir(project), []);
});

// TCRN-CROSS-STORY-470 R5, AC4: a library outside the project, rendered into each host's project settings.
async function writableRootsFixture(t, prefix) {
  const base = await scratchFor(t, prefix);
  const previous = process.env.EINZBERN_HOME;
  process.env.EINZBERN_HOME = join(base, "device");
  t.after(() => {
    process.env.EINZBERN_HOME = previous;
  });
  const project = join(base, "project");
  await mkdir(project);
  const library = join(base, "cloud", "library");
  await runCli(["init", "--workspace", library, "--at", "2026-09-26T09:00:00Z"], { write: () => undefined });
  return { base, project, library };
}

test("TCRN-CROSS-STORY-470 R5, AC4: the writable-roots scope names a library outside the project for each host and keeps the rest of the file", async (t) => {
  const { base, project, library } = await writableRootsFixture(t, "einzbern-host-render-roots-");
  await mkdir(join(project, ".claude"), { recursive: true });
  const claudeBefore = `${JSON.stringify({ permissions: { allow: ["Read(/**)"] }, model: "user-model" }, null, 2)}\n`;
  await writeFile(join(project, ".claude", "settings.local.json"), claudeBefore);

  const plan = await renderWritableRoots({ host: "codex", root: project, library, planOnly: true });
  assert.deepEqual([plan.reasonCode, plan.scope, plan.libraryInsideProject], ["HOST_RENDER_PLAN_READY", "writable-roots", false]);
  assert.deepEqual(plan.files.map((entry) => [entry.path, entry.changed, entry.beforeSha256]), [[".codex/config.toml", true, null]]);
  assert.equal(await readFile(join(project, ".codex", "config.toml"), "utf8").catch(() => null), null, "a plan writes nothing");

  for (const host of ["claude-code", "codex"]) {
    const receipt = await renderWritableRoots({ host, root: project, library, at: "2026-09-26T10:00:00Z" });
    assert.deepEqual([receipt.reasonCode, receipt.scope, receipt.host, receipt.wrote, receipt.libraryPath], ["HOST_RENDER_COMMITTED", "writable-roots", host, true, library]);
    const again = await renderWritableRoots({ host, root: project, library, at: "2026-09-26T10:00:01Z" });
    assert.deepEqual([again.reasonCode, again.wrote, again.backupDir], ["HOST_RENDER_ALREADY_CURRENT", false, null], `${host}: rendering again changes nothing`);
  }
  assert.deepEqual(JSON.parse(await readFile(join(project, ".claude", "settings.local.json"), "utf8")), {
    permissions: { allow: ["Read(/**)"], additionalDirectories: [library] },
    model: "user-model",
  });
  assert.equal(await readFile(join(project, ".codex", "config.toml"), "utf8"), `[sandbox_workspace_write]\nwritable_roots = [${JSON.stringify(library)}]\n`);
  // The Claude file existed and its original went to the device directory first.
  const backups = join(base, "device", "backups", "20260926T100000Z", "writable-roots");
  const [projectDigest] = await readdir(backups);
  assert.equal(await readFile(join(backups, projectDigest, ".claude", "settings.local.json"), "utf8"), claudeBefore);
});

test("TCRN-CROSS-STORY-470 R5, AC4: the writable-roots plan warns when its host config is tracked by Git", async (t) => {
  const { project, library } = await writableRootsFixture(t, "einzbern-host-render-roots-tracked-");
  await mkdir(join(project, ".codex"), { recursive: true });
  const config = join(project, ".codex", "config.toml");
  await writeFile(config, "[features]\nhooks = true\n");
  execFileSync("git", ["-C", project, "init"], { stdio: "ignore" });
  execFileSync("git", ["-C", project, "add", ".codex/config.toml"], { stdio: "ignore" });

  const plan = await renderWritableRoots({ host: "codex", root: project, library, planOnly: true });
  assert.deepEqual(plan.warnings.map((warning) => [warning.reasonCode, warning.file]), [["HOST_WRITABLE_ROOTS_TRACKED_BY_GIT", ".codex/config.toml"]]);
  assert.match(plan.warnings[0].message, /tracked by Git/u);
  assert.deepEqual(await readdir(join(project, ".codex")), ["config.toml"], "planning does not write the tracked file");
});

test("TCRN-CROSS-STORY-470 R5: the native CLI renders the writable-roots scope with --library and refuses a conflicting scope", async (t) => {
  const { base, project, library } = await writableRootsFixture(t, "einzbern-host-render-roots-cli-");
  const env = { ...process.env, EINZBERN_HOME: join(base, "device") };
  assert.equal(refusal(["--host", "codex", "--root", project, "--library", library, "--scope", "user"], env), "HOST_RENDER_SCOPE_CONFLICT");
  assert.equal(refusal(["--host", "codex", "--root", project, "--library", library, "--scope", "project"], env), "HOST_RENDER_SCOPE_CONFLICT");
  assert.equal(refusal(["--host", "codex", "--root", project, "--scope", "writable-roots"], env), "HOST_RENDER_ARGUMENT_MISSING");
  assert.equal(refusal(["--host", "codex", "--root", project, "--library", library, "--at", "yesterday"], env), "TIMESTAMP_INVALID");
  assert.deepEqual(await readdir(project), [], "no refused run wrote anything");

  const receipt = run(["--host", "claude-code", "--root", project, "--library", library], env);
  assert.deepEqual([receipt.reasonCode, receipt.scope, receipt.backupDir], ["HOST_RENDER_COMMITTED", "writable-roots", null]);
  assert.deepEqual(JSON.parse(await readFile(join(project, ".claude", "settings.local.json"), "utf8")), { permissions: { additionalDirectories: [library] } });

  // A library inside the project needs nothing.
  const own = join(project, ".ether");
  await runCli(["init", "--workspace", own, "--at", "2026-09-26T09:30:00Z"], { write: () => undefined });
  const needless = run(["--host", "codex", "--root", project, "--library", own, "--at", "2026-09-26T10:00:00Z"], env);
  assert.deepEqual([needless.reasonCode, needless.libraryInsideProject, needless.files], ["HOST_RENDER_ALREADY_CURRENT", true, []]);
  assert.equal(await readFile(join(project, ".codex", "config.toml"), "utf8").catch(() => null), null);
});
