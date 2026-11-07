// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { hookProtocolOutput } from "../dist/build/packages/core/src/hook-recall.js";
import { applyKiroHookPlan, inspectKiroHookScope, KIRO_HOOKS_FILE, KIRO_USER_HOOKS_FILE, kiroHookEventName, kiroSelectionStatus, mergeKiroHookDocument, planKiroHookScopes, planKiroHooks, probeKiroHost } from "../dist/build/packages/core/src/kiro-host.js";
import { hookLauncherPath, hostHookCommand } from "../dist/build/packages/core/src/host-hooks.js";
import { installSkillCopies, verifySkillCopies } from "../dist/build/packages/core/src/skill-copies.js";
import { runDoctor } from "../dist/build/packages/core/src/doctor.js";
import { SetupRecorder, applyHooks, planHooks } from "../dist/build/packages/core/src/setup-fresh.js";
import { runHookEvent } from "../scripts/einzbern-hook.mjs";

const originalHost = process.env.EINZBERN_HOST;
const originalDeviceHome = process.env.EINZBERN_HOME;
const originalKiroHome = process.env.KIRO_HOME;
const oldHookExitCode = process.exitCode;

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "einzbern-kiro-hooks-"));
  t.after(async () => {
    if (originalHost === undefined) delete process.env.EINZBERN_HOST;
    else process.env.EINZBERN_HOST = originalHost;
    if (originalDeviceHome === undefined) delete process.env.EINZBERN_HOME;
    else process.env.EINZBERN_HOME = originalDeviceHome;
    if (originalKiroHome === undefined) delete process.env.KIRO_HOME;
    else process.env.KIRO_HOME = originalKiroHome;
    process.exitCode = oldHookExitCode;
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    home: join(root, "home"),
    deviceHome: join(root, "device"),
    project: join(root, "project"),
  };
}

async function mkdirFixture({ home, project }) {
  await mkdir(home, { recursive: true });
  await mkdir(project, { recursive: true });
}

function request(root, values = {}) {
  return { root, deviceHome: values.deviceHome, userHome: values.home, scope: values.scope ?? "user", platform: "linux", install: values.install, navigation: values.navigation };
}

test("INIT085-B1: Kiro CLI and IDE identity stay independent; documented aliases and plain-text hooks match V3", async (t) => {
  const f = await fixture(t);
  const bundle = join(f.root, "Kiro.app");
  const info = join(bundle, "Contents");
  await mkdir(info, { recursive: true });
  await writeFile(join(info, "Info.plist"), "<plist><dict><key>CFBundleIdentifier</key><string>dev.kiro.ide</string><key>CFBundleShortVersionString</key><string>1.9.0</string></dict></plist>\n");
  const identity = probeKiroHost({ home: f.home, executable: process.execPath, ideBundlePath: bundle, now: "2026-11-01T00:00:00Z" });
  assert.equal(identity.cli.status, "unknown", "Node's version is not mistaken for a Kiro CLI identity");
  assert.equal(identity.ide.status, "available");
  assert.equal(identity.ide.version, "1.9.0");
  assert.equal(identity.selected, "unknown");
  assert.equal(identity.actualCliHarness.status, "unknown");
  assert.equal(identity.subagentFirstWork.status, "unknown");
  assert.equal(kiroHookEventName("SessionStart"), "SessionStart");
  assert.equal(kiroHookEventName("AgentSpawn"), "SessionStart");
  assert.equal(kiroHookEventName("agentSpawn"), "SessionStart");
  assert.equal(kiroHookEventName("PromptSubmit"), "UserPromptSubmit");
  assert.equal(kiroHookEventName("UserPromptSubmit"), "UserPromptSubmit");
  assert.equal(kiroHookEventName("invoke_sub_agent"), null, "a sub-agent first-work event is not invented");
  assert.equal(hookProtocolOutput("kiro", "UserPromptSubmit", ["one", "two"]), "one\ntwo");
  const previousPrompt = process.env.USER_PROMPT;
  const previousExitCode = process.exitCode;
  process.env.EINZBERN_HOST = "kiro";
  process.env.USER_PROMPT = "prompt accepted by Kiro CLI";
  assert.equal(await runHookEvent({ event: "UserPromptSubmit", payload: {}, cwd: f.root }), null);
  assert.equal(process.exitCode, previousExitCode, "Kiro CLI PromptSubmit hook returns context only and does not refuse submission");
  if (previousPrompt === undefined) delete process.env.USER_PROMPT;
  else process.env.USER_PROMPT = previousPrompt;
});

test("INIT085-B1/B2: Kiro hooks install, repeat cleanly, preserve custom files, update moved paths, and reject edited ownership", async (t) => {
  const f = await fixture(t);
  await mkdirFixture(f);
  const kiroHome = join(f.home, ".kiro");
  const customConfig = {
    version: "v1",
    note: "keep this field",
    hooks: [{ name: "custom-check", trigger: "Stop", action: { type: "command", command: "echo custom" } }, { name: "einzbern-user-hook", trigger: "Stop", action: { type: "agent", prompt: "user owned" } }],
  };
  const userFiles = new Map([
    [join(kiroHome, "hooks", "custom.json"), "{\"version\":\"v1\",\"hooks\":[{\"name\":\"old-hook\"}]}\n"],
    [join(kiroHome, "agents", "custom.json"), "{\"name\":\"custom-agent\"}\n"],
    [join(kiroHome, "settings", "permissions.yaml"), "rules:\n  - capability: fs_read\n    effect: deny\n"],
    [join(kiroHome, "settings", "trust.json"), "{\"trust\":\"user\"}\n"],
  ]);
  for (const [path, content] of userFiles) {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, content);
  }
  await mkdir(join(kiroHome, "hooks"), { recursive: true });
  await writeFile(join(kiroHome, KIRO_USER_HOOKS_FILE), `${JSON.stringify(customConfig, null, 2)}\n`);

  const first = await planKiroHooks(request(kiroHome, { home: f.home, deviceHome: f.deviceHome, navigation: "declined" }));
  assert.equal(first.changed, true);
  await applyKiroHookPlan(first, { at: "2026-11-01T00:00:00Z", deviceHome: f.deviceHome });
  const installed = JSON.parse(await readFile(join(kiroHome, KIRO_USER_HOOKS_FILE), "utf8"));
  assert.equal(installed.note, "keep this field");
  assert.ok(installed.hooks.some(hook => hook.name === "custom-check"));
  assert.ok(installed.hooks.some(hook => hook.name === "einzbern-user-hook"));
  assert.deepEqual(installed.hooks.find(hook => hook.name === "einzbern-prompt-recall").trigger, "UserPromptSubmit");
  assert.ok(installed.hooks.some(hook => hook.name === "einzbern-session-start" && hook.trigger === "SessionStart"));

  const repeated = await planKiroHooks(request(kiroHome, { home: f.home, deviceHome: f.deviceHome, navigation: "declined" }));
  assert.equal(repeated.changed, false, "identical setup writes nothing on repeat");
  for (const [path, content] of userFiles) assert.equal(await readFile(path, "utf8"), content, path);

  const missingHookDocument = JSON.parse(await readFile(join(kiroHome, KIRO_USER_HOOKS_FILE), "utf8"));
  missingHookDocument.hooks = missingHookDocument.hooks.filter(hook => hook.name !== "einzbern-prompt-recall");
  await writeFile(join(kiroHome, KIRO_USER_HOOKS_FILE), `${JSON.stringify(missingHookDocument, null, 2)}\n`);
  const repaired = await planKiroHooks(request(kiroHome, { home: f.home, deviceHome: f.deviceHome, navigation: "declined" }));
  assert.equal(repaired.changed, true, "a missing managed entry is repaired from the remaining ownership evidence");
  await applyKiroHookPlan(repaired, { at: "2026-11-01T00:00:30Z", deviceHome: f.deviceHome });
  assert.ok(JSON.parse(await readFile(join(kiroHome, KIRO_USER_HOOKS_FILE), "utf8")).hooks.some(hook => hook.name === "einzbern-prompt-recall"));

  const relocatedDeviceHome = join(f.root, "moved", "device");
  const relocated = await planKiroHooks(request(kiroHome, { home: f.home, deviceHome: relocatedDeviceHome, navigation: "declined" }));
  assert.equal(relocated.changed, true, "a verified managed command is refreshed after device relocation");
  await applyKiroHookPlan(relocated, { at: "2026-11-01T00:01:00Z", deviceHome: f.deviceHome });
  const refreshed = JSON.parse(await readFile(join(kiroHome, KIRO_USER_HOOKS_FILE), "utf8"));
  const command = refreshed.hooks.find(hook => hook.name === "einzbern-prompt-recall").action.command;
  assert.equal(command, hostHookCommand(hookLauncherPath(relocatedDeviceHome, "linux"), "UserPromptSubmit", f.home, "linux", "kiro"));
  assert.ok(command.includes("process.env.EINZBERN_HOME"), "the command can resolve a moved device from its home-relative path or EINZBERN_HOME");

  const edited = JSON.parse(await readFile(join(kiroHome, KIRO_USER_HOOKS_FILE), "utf8"));
  edited.hooks.find(hook => hook.name === "einzbern-read-guard").enabled = false;
  await writeFile(join(kiroHome, KIRO_USER_HOOKS_FILE), `${JSON.stringify(edited, null, 2)}\n`);
  await assert.rejects(planKiroHooks(request(kiroHome, { home: f.home, deviceHome: relocatedDeviceHome, navigation: "always" })), { reasonCode: "KIRO_HOOKS_OWNERSHIP_CONFLICT" });
  assert.equal(kiroSelectionStatus({ home: f.home, projectRoot: f.project }), "selected");
  assert.equal(kiroSelectionStatus({ home: join(f.root, "unused-home"), projectRoot: join(f.root, "unused-project") }), "not-selected");
  const outside = join(f.root, "outside-hooks.json");
  await writeFile(outside, "{\"version\":\"v1\",\"hooks\":[]}\n");
  await rm(join(kiroHome, KIRO_USER_HOOKS_FILE));
  await symlink(outside, join(kiroHome, KIRO_USER_HOOKS_FILE));
  await assert.rejects(planKiroHooks(request(kiroHome, { home: f.home, deviceHome: f.deviceHome })), { reasonCode: "KIRO_HOOKS_PATH_UNSUPPORTED" });
  assert.notEqual((await inspectKiroHookScope(kiroHome, "user")).error, null, "doctor can report symlinked standalone files as unreadable");
  await rm(join(kiroHome, KIRO_USER_HOOKS_FILE));
  await writeFile(join(kiroHome, KIRO_USER_HOOKS_FILE), "null\n");
  await assert.rejects(planKiroHooks(request(kiroHome, { home: f.home, deviceHome: f.deviceHome })), { reasonCode: "KIRO_HOOKS_FILE_UNSUPPORTED" });
});

test("INIT085-B2: global/project hook scopes avoid duplicate owned execution and uninstall preserves unknown entries", async (t) => {
  const f = await fixture(t);
  await mkdirFixture(f);
  const kiroHome = join(f.home, ".kiro");
  await mkdir(join(f.project, ".kiro", "hooks"), { recursive: true });
  const global = await planKiroHookScopes({ home: f.home, kiroHome, projectRoot: f.project, deviceHome: f.deviceHome, navigation: "always" });
  assert.equal(global[0].changed, true);
  assert.equal(global[1].changed, false, "unselected project scope stays absent");
  await applyKiroHookPlan(global[0], { at: "2026-11-02T00:00:00Z", deviceHome: f.deviceHome });

  const projectCurrent = { version: "v1", hooks: [{ name: "project-custom", trigger: "Stop", action: { type: "command", command: "echo project" } }] };
  const projectOwned = mergeKiroHookDocument(projectCurrent, request(f.project, { home: f.home, deviceHome: f.deviceHome, scope: "project", navigation: "declined" })).document;
  await writeFile(join(f.project, KIRO_HOOKS_FILE), `${JSON.stringify(projectOwned, null, 2)}\n`);
  const scopes = await planKiroHookScopes({ home: f.home, kiroHome, projectRoot: f.project, deviceHome: f.deviceHome, navigation: "declined" });
  assert.equal(scopes[0].removed.length, 2, "global owned hooks are retired when a workspace already owns the integration");
  assert.equal(scopes[1].changed, false, "an already current workspace keeps its exact owned hooks");
  await applyKiroHookPlan(scopes[0], { at: "2026-11-02T00:01:00Z", deviceHome: f.deviceHome });
  await applyKiroHookPlan(scopes[1], { at: "2026-11-02T00:01:00Z", deviceHome: f.deviceHome });
  const active = JSON.parse(await readFile(join(f.project, KIRO_HOOKS_FILE), "utf8"));
  const retired = JSON.parse(await readFile(join(kiroHome, KIRO_USER_HOOKS_FILE), "utf8"));
  assert.equal(active.hooks.filter(hook => hook.name.startsWith("einzbern-prompt")).length, 1);
  assert.ok(active.hooks.some(hook => hook.name === "project-custom"));
  assert.equal(retired.hooks.length, 0);

  const existing = { version: "v1", customTopLevel: true, hooks: [...active.hooks, { name: "einzbern-user-custom", trigger: "Stop", action: { type: "agent", prompt: "user" } }] };
  const uninstalled = mergeKiroHookDocument(existing, { ...request(f.project, { home: f.home, deviceHome: f.deviceHome, scope: "project", install: false }), navigation: "always" });
  assert.ok(uninstalled.document.hooks.some(hook => hook.name === "project-custom"));
  assert.ok(uninstalled.document.hooks.some(hook => hook.name === "einzbern-user-custom"));
  assert.equal(uninstalled.document.customTopLevel, true);
  assert.equal(uninstalled.document.hooks.some(hook => hook.name === "einzbern-prompt-recall"), false);
});

test("INIT085-B2: fresh and uninstall wiring uses the selected KIRO_HOME and removes only owned hooks", async (t) => {
  const f = await fixture(t);
  await mkdirFixture(f);
  const kiroHome = join(f.home, "custom-kiro-home");
  await mkdir(kiroHome, { recursive: true });
  process.env.KIRO_HOME = kiroHome;
  const hookPath = join(kiroHome, KIRO_USER_HOOKS_FILE);
  const planned = new SetupRecorder(f.deviceHome, "2026-11-02T00:00:00Z");
  await planHooks(planned, f.home, f.deviceHome, null, true, undefined, false, f.project);
  assert.ok(planned.writes.some(write => write.path === hookPath), "fresh setup plans the standalone Kiro user hook file");
  assert.equal(await readFile(hookPath, "utf8").catch(() => null), null, "planning does not write Kiro configuration");

  await applyHooks(new SetupRecorder(f.deviceHome, "2026-11-02T00:01:00Z"), {
    home: f.home, projectRoot: f.project, deviceHome: f.deviceHome, at: "2026-11-02T00:01:00Z", navigation: null, install: true,
  });
  const installed = JSON.parse(await readFile(hookPath, "utf8"));
  assert.equal(installed.hooks.filter(hook => hook.name.startsWith("einzbern-")).length, 2);
  installed.hooks.push({ name: "user-owned", trigger: "Stop", action: { type: "agent", prompt: "keep me" } });
  await writeFile(hookPath, `${JSON.stringify(installed, null, 2)}\n`);

  const uninstallPlan = new SetupRecorder(f.deviceHome, "2026-11-02T00:02:00Z");
  await planHooks(uninstallPlan, f.home, f.deviceHome, null, false, undefined, false, f.project);
  assert.ok(uninstallPlan.writes.some(write => write.path === hookPath));
  await applyHooks(uninstallPlan, {
    home: f.home, projectRoot: f.project, deviceHome: f.deviceHome, at: "2026-11-02T00:02:00Z", navigation: null, install: false,
  });
  const remaining = JSON.parse(await readFile(hookPath, "utf8"));
  assert.deepEqual(remaining.hooks.map(hook => hook.name), ["user-owned"]);
});

test("INIT085-B2: selected Kiro skill copies are owned, repeatable, upgradeable, and modified bytes are detected", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.root, "skill"), { recursive: true });
  const source = join(f.root, "skill");
  await writeFile(join(source, "SKILL.md"), "# Mana\n\nversion one\n");
  const kiroHome = join(f.home, "kiro-config");
  const first = await installSkillCopies({ source, now: "2026-11-03T00:00:00Z", home: f.home, deviceHome: f.deviceHome, includeKiro: true, kiroHome });
  assert.ok(first.copies.some(copy => copy.host === "kiro" && copy.path === join(kiroHome, "skills", "mana-orchestrate")));
  assert.equal((await verifySkillCopies({ home: f.home, deviceHome: f.deviceHome, includeKiro: true, kiroHome })).ok, true);
  const repeated = await installSkillCopies({ source, now: "2026-11-03T00:01:00Z", home: f.home, deviceHome: f.deviceHome, includeKiro: true, kiroHome });
  assert.equal(repeated.reasonCode, "SKILL_COPIES_CURRENT");

  await writeFile(join(source, "SKILL.md"), "# Mana\n\nversion two\n");
  const upgraded = await installSkillCopies({ source, now: "2026-11-03T00:02:00Z", home: f.home, deviceHome: f.deviceHome, includeKiro: true, kiroHome });
  const kiroCopy = upgraded.copies.find(copy => copy.host === "kiro");
  assert.equal(kiroCopy.action, "replaced");
  assert.equal(await readFile(join(kiroCopy.backup, "SKILL.md"), "utf8"), "# Mana\n\nversion one\n");
  await writeFile(join(source, "SKILL.md"), "# Mana\n\nversion one\n");
  const rolledBack = await installSkillCopies({ source, now: "2026-11-03T00:03:00Z", home: f.home, deviceHome: f.deviceHome, includeKiro: true, kiroHome });
  assert.equal(rolledBack.copies.find(copy => copy.host === "kiro").action, "replaced");
  assert.equal(await readFile(join(kiroHome, "skills", "mana-orchestrate", "SKILL.md"), "utf8"), "# Mana\n\nversion one\n");
  const modifiedPath = join(kiroHome, "skills", "mana-orchestrate", "SKILL.md");
  await writeFile(modifiedPath, "# user edit\n");
  const verification = await verifySkillCopies({ home: f.home, deviceHome: f.deviceHome, includeKiro: true, kiroHome });
  assert.equal(verification.ok, false);
  assert.equal(await readFile(modifiedPath, "utf8"), "# user edit\n", "verification leaves modified bytes for review");
});

test("INIT085-B2: doctor reports Kiro applicability as not-selected or selected without merging IDE and CLI", async (t) => {
  const f = await fixture(t);
  await mkdirFixture(f);
  delete process.env.KIRO_HOME;
  const run = () => runDoctor({ projectRoot: f.project, home: f.home, deviceHome: f.deviceHome, platform: "linux", env: { ...process.env, KIRO_HOME: undefined } });
  const first = (await run()).find(check => check.check === "hooks-present");
  const firstKiro = first.detail.hosts.find(host => host.host === "kiro");
  assert.equal(firstKiro.applicability, "not-selected");
  assert.equal(firstKiro.selection, "not-selected");
  assert.equal(firstKiro.ideBundleId, null);
  await mkdir(join(f.project, ".kiro"), { recursive: true });
  const second = (await run()).find(check => check.check === "hooks-present");
  const secondKiro = second.detail.hosts.find(host => host.host === "kiro");
  assert.equal(secondKiro.applicability, "selected");
  assert.equal(secondKiro.selection, "selected");
  assert.deepEqual(secondKiro.causes, ["HOOK_MISSING"]);

  const installed = mergeKiroHookDocument({ version: "v1", hooks: [] }, request(f.project, { home: f.home, deviceHome: f.deviceHome, scope: "project", navigation: "always" })).document;
  await mkdir(join(f.project, ".kiro", "hooks"), { recursive: true });
  const projectHooksPath = join(f.project, KIRO_HOOKS_FILE);
  await writeFile(projectHooksPath, `${JSON.stringify(installed, null, 2)}\n`);
  const third = (await run()).find(check => check.check === "hooks-present");
  const thirdKiro = third.detail.hosts.find(host => host.host === "kiro");
  assert.equal(thirdKiro.hooks, 2, "two distinct owned hooks in the active file are not duplicates");
  assert.deepEqual(thirdKiro.causes, []);
  installed.hooks.find(hook => hook.name === "einzbern-read-guard").enabled = false;
  await writeFile(projectHooksPath, `${JSON.stringify(installed, null, 2)}\n`);
  const fourth = (await run()).find(check => check.check === "hooks-present");
  const fourthKiro = fourth.detail.hosts.find(host => host.host === "kiro");
  assert.deepEqual(fourthKiro.causes, ["HOOK_NOT_AS_EXPECTED"], "a conflicting managed entry is reported without aborting doctor");
});

test("INIT085-B1: known Kiro read tool uses exit code 2 for denial; unfamiliar inputs remain unknown", async (t) => {
  const f = await fixture(t);
  const largePath = join(f.root, "large.txt");
  const smallPath = join(f.root, "small.txt");
  const { AGENT_OUTPUT_MAX_BYTES } = await import("../dist/build/packages/core/src/runtime-input-contract.js");
  await writeFile(largePath, Buffer.alloc(AGENT_OUTPUT_MAX_BYTES + 1, 97));
  await writeFile(smallPath, "ok\n");
  process.env.EINZBERN_HOST = "kiro";
  process.env.EINZBERN_HOME = f.deviceHome;
  const denied = await runHookEvent({ event: "PreToolUse", payload: { hook_event_name: "PreToolUse", tool_name: "read_file", tool_input: { path: largePath } }, cwd: f.root });
  assert.equal(denied, null);
  assert.equal(process.exitCode, 2);
  process.exitCode = undefined;
  const unknown = await runHookEvent({ event: "PreToolUse", payload: { hook_event_name: "PreToolUse", tool_name: "custom_mcp_read", tool_input: { path: largePath } }, cwd: f.root });
  assert.equal(unknown, null);
  assert.equal(process.exitCode, undefined);
  const allowed = await runHookEvent({ event: "PreToolUse", payload: { hook_event_name: "PreToolUse", tool_name: "read_file", tool_input: { path: smallPath } }, cwd: f.root });
  assert.equal(allowed, null);
  assert.equal(process.exitCode, undefined);
});
