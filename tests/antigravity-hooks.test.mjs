// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { hookProtocolOutput } from "../dist/build/packages/core/src/hook-recall.js";
import {
  ANTIGRAVITY_HOOKS_FILE,
  ANTIGRAVITY_OWNED_HOOK_GROUP,
  ANTIGRAVITY_READ_MATCHER,
  ANTIGRAVITY_USER_HOOKS_FILE,
  antigravityConfigRoot,
  antigravityHookEventName,
  antigravitySelectionStatus,
  applyAntigravityHookPlan,
  inspectAntigravityHookScope,
  mergeAntigravityHookDocument,
  planAntigravityHookScopes,
  planAntigravityHooks,
  probeAntigravityHost,
} from "../dist/build/packages/core/src/antigravity-host.js";
import { hookLauncherPath, hostHookCommand } from "../dist/build/packages/core/src/host-hooks.js";
import { installSkillCopies, verifySkillCopies } from "../dist/build/packages/core/src/skill-copies.js";
import { runDoctor } from "../dist/build/packages/core/src/doctor.js";
import { SetupRecorder, applyHooks, planHooks } from "../dist/build/packages/core/src/setup-fresh.js";
import { createProject, createWork, initializeLibrary, setWorkspaceSetting } from "../dist/build/packages/core/src/index.js";
import { registerLibrary } from "../dist/build/packages/core/src/registry.js";
import { deriveStableId } from "../dist/build/packages/protocol/src/index.js";
import { runHookEvent } from "../scripts/einzbern-hook.mjs";

const originalHost = process.env.EINZBERN_HOST;
const originalDeviceHome = process.env.EINZBERN_HOME;
const originalAntigravityConfig = process.env.ANTIGRAVITY_CONFIG_DIR;
const oldHookExitCode = process.exitCode;

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "einzbern-agy-hooks-")));
  t.after(async () => {
    if (originalHost === undefined) delete process.env.EINZBERN_HOST;
    else process.env.EINZBERN_HOST = originalHost;
    if (originalDeviceHome === undefined) delete process.env.EINZBERN_HOME;
    else process.env.EINZBERN_HOME = originalDeviceHome;
    if (originalAntigravityConfig === undefined) delete process.env.ANTIGRAVITY_CONFIG_DIR;
    else process.env.ANTIGRAVITY_CONFIG_DIR = originalAntigravityConfig;
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
  return {
    root,
    deviceHome: values.deviceHome,
    userHome: values.home,
    scope: values.scope ?? "user",
    platform: "linux",
    install: values.install,
    navigation: values.navigation,
  };
}

test("INIT091-A1: Antigravity CLI and surface probes stay independent and protocol outputs emit valid JSON", async (t) => {
  const f = await fixture(t);
  await mkdirFixture(f);
  await mkdir(join(f.home, ".gemini", "config"), { recursive: true });
  await mkdir(join(f.home, ".gemini", "antigravity-ide"), { recursive: true });
  const fakeAgy = join(f.home, ".local", "bin", "agy");
  await mkdir(join(f.home, ".local", "bin"), { recursive: true });
  await writeFile(fakeAgy, "#!/bin/sh\necho 'Antigravity CLI 0.2.2'\n", { mode: 0o755 });

  const notDetected = probeAntigravityHost({ home: f.home, env: { PATH: join(f.root, "empty-bin") }, observedAt: "2026-11-11T00:00:00Z" });
  assert.equal(notDetected.cli.status, "not-detected");
  assert.deepEqual(notDetected.surfaces, { configDir: true, cliDataDir: false, ideDataDir: true, appDataDir: false });
  assert.equal(notDetected.selected, "unknown");
  assert.equal(notDetected.actualModel.status, "unknown");

  const fallbackCli = probeAntigravityHost({ home: f.home, env: {}, observedAt: "2026-11-11T00:00:01Z" });
  assert.equal(fallbackCli.cli.status, "available");
  assert.equal(fallbackCli.cli.version, "0.2.2");
  assert.equal(fallbackCli.cli.executable, fakeAgy);

  assert.equal(antigravityHookEventName("SessionStart"), "SessionStart");
  assert.equal(antigravityHookEventName("PreInvocation"), "UserPromptSubmit");
  assert.equal(antigravityHookEventName("UserPromptSubmit"), "UserPromptSubmit");
  assert.equal(antigravityHookEventName("PreToolUse"), "PreToolUse");
  assert.equal(antigravityHookEventName("UnknownTrigger"), null);

  const injected = JSON.parse(hookProtocolOutput("antigravity", "UserPromptSubmit", ["line one", "line two"]));
  assert.deepEqual(injected, { injectSteps: [{ systemMessage: { systemMessage: "line one\nline two" } }] });

  // Shell command fallback emits valid JSON without inner double-quote breakage when launcher is absent.
  for (const [event, expected] of [["UserPromptSubmit", "{}\n"], ["PreToolUse", "{\"decision\":\"allow\"}\n"]]) {
    const cmd = hostHookCommand(join(f.deviceHome, "missing", "hook.mjs"), event, f.home, "linux", "antigravity");
    const run = spawnSync("sh", ["-c", cmd], { encoding: "utf8", input: "{}" });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, expected);
    assert.doesNotThrow(() => JSON.parse(run.stdout));
  }
});

test("INIT091-A2: Antigravity hooks merge only the einzbern group, preserve other groups, and detect ownership conflicts", async (t) => {
  const f = await fixture(t);
  await mkdirFixture(f);
  const configRoot = antigravityConfigRoot({ home: f.home });
  await mkdir(configRoot, { recursive: true });
  const customHooks = {
    "user-security": {
      PreToolUse: [{ matcher: "run_command", hooks: [{ type: "command", command: "echo ok", timeout: 10 }] }],
    },
    "team-telemetry": {
      PostInvocation: [{ type: "command", command: "echo done", timeout: 5 }],
    },
  };
  const hookFile = join(configRoot, ANTIGRAVITY_USER_HOOKS_FILE);
  await writeFile(hookFile, `${JSON.stringify(customHooks, null, 2)}\n`);

  const first = await planAntigravityHooks(request(configRoot, { home: f.home, deviceHome: f.deviceHome, navigation: "declined" }));
  assert.equal(first.changed, true);
  assert.equal(first.preservedGroupCount, 2);
  await applyAntigravityHookPlan(first, { at: "2026-11-11T00:00:00Z", deviceHome: f.deviceHome });
  const installed = JSON.parse(await readFile(hookFile, "utf8"));
  assert.deepEqual(Object.keys(installed), ["user-security", "team-telemetry", ANTIGRAVITY_OWNED_HOOK_GROUP]);
  assert.equal(installed[ANTIGRAVITY_OWNED_HOOK_GROUP].PreToolUse[0].matcher, ANTIGRAVITY_READ_MATCHER);
  assert.equal(installed[ANTIGRAVITY_OWNED_HOOK_GROUP].SessionStart.length, 1);
  assert.equal(installed[ANTIGRAVITY_OWNED_HOOK_GROUP].PreInvocation.length, 1);

  const repeated = await planAntigravityHooks(request(configRoot, { home: f.home, deviceHome: f.deviceHome, navigation: "declined" }));
  assert.equal(repeated.changed, false, "identical setup writes nothing on repeat");

  const relocatedDevice = join(f.root, "relocated", "team's device");
  const relocated = await planAntigravityHooks(request(configRoot, { home: f.home, deviceHome: relocatedDevice, navigation: "always" }));
  assert.equal(relocated.changed, true);
  await applyAntigravityHookPlan(relocated, { at: "2026-11-11T00:01:00Z", deviceHome: f.deviceHome });
  const refreshed = JSON.parse(await readFile(hookFile, "utf8"));
  assert.equal(refreshed[ANTIGRAVITY_OWNED_HOOK_GROUP].SessionStart, undefined);
  assert.equal(
    refreshed[ANTIGRAVITY_OWNED_HOOK_GROUP].PreInvocation[0].command,
    hostHookCommand(hookLauncherPath(relocatedDevice, "linux"), "UserPromptSubmit", f.home, "linux", "antigravity"),
  );

  // Editing the owned group triggers ANTIGRAVITY_HOOKS_OWNERSHIP_CONFLICT.
  refreshed[ANTIGRAVITY_OWNED_HOOK_GROUP].PreToolUse[0].matcher = "edited_matcher";
  await writeFile(hookFile, `${JSON.stringify(refreshed, null, 2)}\n`);
  await assert.rejects(
    planAntigravityHooks(request(configRoot, { home: f.home, deviceHome: relocatedDevice, navigation: "always" })),
    { reasonCode: "ANTIGRAVITY_HOOKS_OWNERSHIP_CONFLICT" },
  );

  // Bare ~/.agents/skills (Codex) and bare <project>/.agents do NOT select Antigravity.
  const cleanHome = join(f.root, "codex-only-home");
  const cleanProject = join(f.root, "codex-only-project");
  await mkdir(join(cleanHome, ".agents", "skills"), { recursive: true });
  await mkdir(join(cleanProject, ".agents"), { recursive: true });
  assert.equal(antigravitySelectionStatus({ home: cleanHome, projectRoot: cleanProject }), "not-selected");
  assert.equal(antigravitySelectionStatus({ home: f.home, projectRoot: f.project }), "selected");

  // Symlink and non-object JSON handling.
  const outside = join(f.root, "outside.json");
  await writeFile(outside, "{}\n");
  await rm(hookFile);
  await symlink(outside, hookFile);
  await assert.rejects(planAntigravityHooks(request(configRoot, { home: f.home, deviceHome: f.deviceHome })), { reasonCode: "ANTIGRAVITY_HOOKS_PATH_UNSUPPORTED" });
  assert.notEqual((await inspectAntigravityHookScope(configRoot, "user")).error, null);
  await rm(hookFile);
  await writeFile(hookFile, "[]\n");
  await assert.rejects(planAntigravityHooks(request(configRoot, { home: f.home, deviceHome: f.deviceHome })), { reasonCode: "ANTIGRAVITY_HOOKS_FILE_UNSUPPORTED" });
});

test("INIT091-A2: edited PreInvocation or PreToolUse commands report ANTIGRAVITY_HOOKS_OWNERSHIP_CONFLICT and preserve edits across update, repair, and uninstall", async (t) => {
  const f = await fixture(t);
  await mkdirFixture(f);
  const configRoot = antigravityConfigRoot({ home: f.home });
  await mkdir(configRoot, { recursive: true });
  delete process.env.ANTIGRAVITY_CONFIG_DIR;
  const userHookFile = join(configRoot, ANTIGRAVITY_USER_HOOKS_FILE);

  const installBaseline = async () => {
    const plan = await planAntigravityHooks(request(configRoot, { home: f.home, deviceHome: f.deviceHome, navigation: "always" }));
    await applyAntigravityHookPlan(plan, { at: "2026-11-11T00:01:30Z", deviceHome: f.deviceHome });
  };

  for (const mutate of [
    (doc) => {
      doc.einzbern.PreInvocation[0].command = doc.einzbern.PreInvocation[0].command.replace(
        "process.env.EINZBERN_HOST='antigravity';",
        "process.env.EINZBERN_HOST='antigravity';process.env.TEAM_HOOK_MODE='custom-pre-invocation';",
      );
      return "custom-pre-invocation";
    },
    (doc) => {
      doc.einzbern.PreToolUse[0].hooks[0].command = doc.einzbern.PreToolUse[0].hooks[0].command.replace(
        "process.env.EINZBERN_HOST='antigravity';",
        "process.env.EINZBERN_HOST='antigravity';process.env.TEAM_HOOK_MODE='custom-pre-tool-use';",
      );
      return "custom-pre-tool-use";
    },
  ]) {
    await rm(f.deviceHome, { recursive: true, force: true });
    await rm(userHookFile, { force: true });
    await installBaseline();
    const doc = JSON.parse(await readFile(userHookFile, "utf8"));
    const marker = mutate(doc);
    const editedBytes = `${JSON.stringify(doc, null, 2)}\n`;
    await writeFile(userHookFile, editedBytes);

    // Direct planner refuses on both install=true (update/repair) and install=false (uninstall).
    await assert.rejects(
      planAntigravityHooks(request(configRoot, { home: f.home, deviceHome: f.deviceHome, navigation: "always", install: true })),
      { reasonCode: "ANTIGRAVITY_HOOKS_OWNERSHIP_CONFLICT" },
    );
    await assert.rejects(
      planAntigravityHooks(request(configRoot, { home: f.home, deviceHome: f.deviceHome, navigation: "always", install: false })),
      { reasonCode: "ANTIGRAVITY_HOOKS_OWNERSHIP_CONFLICT" },
    );

    // Setup planHooks blocks update/repair (navigation written & declined) and uninstall (install=false) while preserving file bytes.
    for (const [label, nav, install] of [
      ["repair", "written", true],
      ["update-declined", "declined", true],
      ["uninstall", null, false],
    ]) {
      const recorder = new SetupRecorder(f.deviceHome, "2026-11-11T00:01:45Z");
      await planHooks(recorder, f.home, f.deviceHome, nav, install, undefined, false, f.project);
      assert.ok(
        recorder.blockers.some((b) => b.path === userHookFile && b.reasonCode === "ANTIGRAVITY_HOOKS_OWNERSHIP_CONFLICT"),
        `${label} must block on edited ${marker}`,
      );
      assert.equal(recorder.writes.some((w) => w.path === userHookFile), false);
      await assert.rejects(
        applyHooks(new SetupRecorder(f.deviceHome, "2026-11-11T00:01:50Z"), {
          home: f.home,
          projectRoot: f.project,
          deviceHome: f.deviceHome,
          at: "2026-11-11T00:01:50Z",
          navigation: nav,
          install,
        }),
        { reasonCode: "ANTIGRAVITY_HOOKS_OWNERSHIP_CONFLICT" },
      );
      const preserved = await readFile(userHookFile, "utf8");
      assert.equal(preserved, editedBytes);
      assert.equal(preserved.includes(marker), true);
    }
  }

  // Also protect user-edited project-local .agents/hooks.json during scope retirement and uninstall.
  await rm(f.deviceHome, { recursive: true, force: true });
  await rm(userHookFile, { force: true });
  await installBaseline();
  const projectHookFile = join(f.project, ANTIGRAVITY_HOOKS_FILE);
  await mkdir(join(f.project, ".agents"), { recursive: true });
  const localDoc = mergeAntigravityHookDocument({}, request(f.project, { home: f.home, deviceHome: f.deviceHome, scope: "project", navigation: "always" })).document;
  localDoc.einzbern.PreToolUse[0].hooks[0].command = localDoc.einzbern.PreToolUse[0].hooks[0].command.replace(
    "process.env.EINZBERN_HOST='antigravity';",
    "process.env.EINZBERN_HOST='antigravity';process.env.TEAM_HOOK_MODE='custom-local';",
  );
  const editedLocalBytes = `${JSON.stringify(localDoc, null, 2)}\n`;
  await writeFile(projectHookFile, editedLocalBytes);
  const localRepairRecorder = new SetupRecorder(f.deviceHome, "2026-11-11T00:01:55Z");
  await planHooks(localRepairRecorder, f.home, f.deviceHome, "written", true, undefined, false, f.project);
  assert.ok(localRepairRecorder.blockers.some((b) => b.path === projectHookFile && b.reasonCode === "ANTIGRAVITY_HOOKS_OWNERSHIP_CONFLICT"));
  assert.equal(await readFile(projectHookFile, "utf8"), editedLocalBytes);
});

test("INIT091-A2: multi-project repair preserves global hooks for sibling projects, retires redundant unedited local group, keeps unmanaged groups, and stays idempotent", async (t) => {
  const f = await fixture(t);
  const projectA = join(f.root, "project-a");
  const projectB = join(f.root, "project-b");
  const configRoot = antigravityConfigRoot({ home: f.home });
  await mkdir(configRoot, { recursive: true });
  await mkdir(join(projectA, ".agents"), { recursive: true });
  await mkdir(projectB, { recursive: true });
  await mkdir(join(f.deviceHome, "engine"), { recursive: true });
  await writeFile(hookLauncherPath(f.deviceHome, "linux"), "// launcher\n");

  await writeFile(
    join(configRoot, ANTIGRAVITY_USER_HOOKS_FILE),
    `${JSON.stringify({ "user-security": { PreToolUse: [{ matcher: "run_command", hooks: [{ type: "command", command: "echo guard", timeout: 10 }] }] } }, null, 2)}\n`,
  );

  const common = { home: f.home, antigravityConfigHome: configRoot, deviceHome: f.deviceHome, navigation: "always", platform: "linux" };
  const repair = async (projectRoot, at) => {
    const plans = await planAntigravityHookScopes({ ...common, projectRoot });
    for (const plan of plans) {
      await applyAntigravityHookPlan(plan, { at, deviceHome: f.deviceHome });
    }
    return plans;
  };

  // Project B relies on global hooks.json.
  await repair(projectB, "2026-11-11T00:02:00Z");
  assert.equal((await inspectAntigravityHookScope(configRoot, "user")).count, 2);
  assert.equal((await inspectAntigravityHookScope(projectB, "project")).count, 0);

  // Project A has an unmanaged local group plus an unedited owned local "einzbern" group.
  const projectInitial = { "project-lint": { PostToolUse: [{ matcher: "write_file", hooks: [{ type: "command", command: "echo lint", timeout: 10 }] }] } };
  const projectMerged = mergeAntigravityHookDocument(projectInitial, request(projectA, { home: f.home, deviceHome: f.deviceHome, scope: "project", navigation: "always" })).document;
  await writeFile(join(projectA, ANTIGRAVITY_HOOKS_FILE), `${JSON.stringify(projectMerged, null, 2)}\n`);

  // Repairing A must NOT delete B's global dependency, and must retire A's redundant owned group while keeping "project-lint".
  const aFirstPlans = await repair(projectA, "2026-11-11T00:03:00Z");
  assert.equal(aFirstPlans[0].changed, false, "global hooks remain intact when repairing A");
  assert.deepEqual(aFirstPlans[1].removed, [ANTIGRAVITY_OWNED_HOOK_GROUP], "redundant unedited local einzbern group is retired");
  assert.equal((await inspectAntigravityHookScope(configRoot, "user")).count, 2);
  assert.equal((await inspectAntigravityHookScope(projectA, "project")).count, 0);
  assert.equal((await inspectAntigravityHookScope(projectB, "project")).count, 0);

  const globalAfterA = JSON.parse(await readFile(join(configRoot, ANTIGRAVITY_USER_HOOKS_FILE), "utf8"));
  assert.deepEqual(Object.keys(globalAfterA), ["user-security", ANTIGRAVITY_OWNED_HOOK_GROUP]);
  const localAfterA = JSON.parse(await readFile(join(projectA, ANTIGRAVITY_HOOKS_FILE), "utf8"));
  assert.deepEqual(Object.keys(localAfterA), ["project-lint"]);

  // Alternating repairs across B and A remain 100% idempotent with exactly one effective owned group per project.
  const bSecondPlans = await repair(projectB, "2026-11-11T00:03:10Z");
  assert.equal(bSecondPlans.every((plan) => !plan.changed), true);
  const aSecondPlans = await repair(projectA, "2026-11-11T00:03:20Z");
  assert.equal(aSecondPlans.every((plan) => !plan.changed), true);
  assert.equal((await inspectAntigravityHookScope(configRoot, "user")).count, 2);
  assert.equal((await inspectAntigravityHookScope(projectA, "project")).count, 0);
  assert.equal((await inspectAntigravityHookScope(projectB, "project")).count, 0);

  for (const projectRoot of [projectA, projectB]) {
    const docHost = (await runDoctor({ projectRoot, home: f.home, deviceHome: f.deviceHome, platform: "linux", env: { ...process.env, ANTIGRAVITY_CONFIG_DIR: configRoot } }))
      .find((entry) => entry.check === "hooks-present")
      .detail.hosts.find((host) => host.host === "antigravity");
    assert.equal(docHost.hooks, 2);
    assert.deepEqual(docHost.causes, []);
  }
});

test("INIT091-A2: fresh/uninstall wiring honors ANTIGRAVITY_CONFIG_DIR, manages skill copies, and passes doctor checks", async (t) => {
  const f = await fixture(t);
  await mkdirFixture(f);
  const customConfig = join(f.home, "custom-antigravity-config");
  await mkdir(customConfig, { recursive: true });
  process.env.ANTIGRAVITY_CONFIG_DIR = customConfig;
  const hookPath = join(customConfig, ANTIGRAVITY_USER_HOOKS_FILE);

  const planned = new SetupRecorder(f.deviceHome, "2026-11-11T00:04:00Z");
  await planHooks(planned, f.home, f.deviceHome, null, true, undefined, false, f.project);
  assert.ok(planned.writes.some((write) => write.path === hookPath));

  await applyHooks(new SetupRecorder(f.deviceHome, "2026-11-11T00:04:10Z"), {
    home: f.home, projectRoot: f.project, deviceHome: f.deviceHome, at: "2026-11-11T00:04:10Z", navigation: null, install: true,
  });
  const installed = JSON.parse(await readFile(hookPath, "utf8"));
  installed["keep-me"] = { SessionStart: [{ type: "command", command: "echo hi", timeout: 5 }] };
  await writeFile(hookPath, `${JSON.stringify(installed, null, 2)}\n`);

  const docSelected = (await runDoctor({ projectRoot: f.project, home: f.home, deviceHome: f.deviceHome, platform: "linux", env: { ...process.env, ANTIGRAVITY_CONFIG_DIR: customConfig } }))
    .find((entry) => entry.check === "hooks-present")
    .detail.hosts.find((host) => host.host === "antigravity");
  assert.equal(docSelected.selection, "selected");
  assert.equal(docSelected.applicability, "selected");
  assert.equal(docSelected.hooks, 2);
  assert.deepEqual(docSelected.causes, []);

  // Skill copies lifecycle for Antigravity.
  const skillSource = join(f.root, "skill-src");
  await mkdir(skillSource, { recursive: true });
  await writeFile(join(skillSource, "SKILL.md"), "# Mana\n\nv1\n");
  const copied = await installSkillCopies({
    source: skillSource, now: "2026-11-11T00:05:00Z", home: f.home, deviceHome: f.deviceHome,
    includeAntigravity: true, antigravityConfigHome: customConfig,
  });
  assert.ok(copied.copies.some((copy) => copy.host === "antigravity" && copy.path === join(customConfig, "skills", "mana-orchestrate")));
  assert.equal((await verifySkillCopies({ home: f.home, deviceHome: f.deviceHome, includeAntigravity: true, antigravityConfigHome: customConfig })).ok, true);

  await writeFile(join(customConfig, "skills", "mana-orchestrate", "SKILL.md"), "# user modified\n");
  assert.equal((await verifySkillCopies({ home: f.home, deviceHome: f.deviceHome, includeAntigravity: true, antigravityConfigHome: customConfig })).ok, false);

  // Uninstall removes only owned einzbern hook group and preserves keep-me.
  const uninstallPlan = new SetupRecorder(f.deviceHome, "2026-11-11T00:06:00Z");
  await planHooks(uninstallPlan, f.home, f.deviceHome, null, false, undefined, false, f.project);
  await applyHooks(uninstallPlan, {
    home: f.home, projectRoot: f.project, deviceHome: f.deviceHome, at: "2026-11-11T00:06:00Z", navigation: null, install: false,
  });
  assert.deepEqual(Object.keys(JSON.parse(await readFile(hookPath, "utf8"))), ["keep-me"]);
});

test("INIT091-A3a: PreInvocation recalls on 0-indexed first turn for main and subagent sessions, skips tool-loop turns, and resolves workspacePaths", async (t) => {
  const f = await fixture(t);
  await mkdirFixture(f);
  process.env.EINZBERN_HOST = "antigravity";
  process.env.EINZBERN_HOME = f.deviceHome;

  // Unregistered project still returns valid JSON "{}\n" on exit 0.
  assert.equal(await runHookEvent({ event: "PreInvocation", payload: { invocationNum: 0, lastUserInput: "hello" }, cwd: f.root }), "{}\n");

  // Canonicalize libraryPath via realpath so macOS /var/folders vs /private/var/folders matches registry.
  const libraryPath = join(await realpath(f.root), "library.ether");
  await initializeLibrary({ root: libraryPath, createdAt: "2026-11-11T00:00:00Z" });
  const projectId = (await createProject(libraryPath, { occurredAt: "2026-11-11T00:00:01Z", externalKey: "AGY-PROJECT", name: "Antigravity" })).projects[0].id;
  await createWork(libraryPath, {
    occurredAt: "2026-11-11T00:00:02Z",
    projectId,
    externalKey: "AGY-INIT",
    kind: "Initiative",
    parentId: null,
    title: "Zephyr Quartz Initiative",
    scope: "## Goal\nPreserve Zephyr Quartz invariants.",
  });
  await createWork(libraryPath, {
    occurredAt: "2026-11-11T00:00:03Z",
    projectId,
    externalKey: "AGY-EPIC",
    kind: "Epic",
    parentId: deriveStableId("work", "AGY-INIT"),
    title: "Zephyr Quartz Epic",
    goal: "Maintain Zephyr Quartz hook contract.",
  });
  await createWork(libraryPath, {
    occurredAt: "2026-11-11T00:00:04Z",
    projectId,
    externalKey: "AGY-STORY",
    kind: "Story",
    parentId: deriveStableId("work", "AGY-EPIC"),
    title: "Antigravity Zephyr Quartz Protocol",
    goal: "Always preserve Zephyr Quartz invariants during Antigravity hook dispatch.",
    acceptance: "GIVEN Antigravity WHEN PreInvocation fires THEN Zephyr Quartz recalls",
  });
  await setWorkspaceSetting(libraryPath, { occurredAt: "2026-11-11T00:00:05Z", key: "retrieval.tau", value: "1" });
  const registered = await registerLibrary({ projectPath: f.project, libraryPath, registeredAt: "2026-11-11T00:00:09Z" });
  assert.equal(registered.libraryPath, libraryPath);

  // Main session first model invocation (invocationNum: 0) with workspacePaths fallback (no cwd).
  const mainFirst = await runHookEvent({
    event: "PreInvocation",
    payload: {
      conversationId: "conv-main-session",
      invocationNum: 0,
      lastUserInput: "Antigravity Zephyr Quartz Protocol",
      workspacePaths: [f.project],
    },
    libraryPath: registered.libraryPath,
  });
  const parsedMainFirst = JSON.parse(mainFirst);
  assert.ok(parsedMainFirst.injectSteps?.[0]?.systemMessage?.systemMessage?.includes("Zephyr Quartz"), mainFirst);

  // Subsequent tool-loop invocations in the same conversation (invocationNum: 1, 2) do not re-inject.
  for (const loopTurn of [1, 2]) {
    const skipped = await runHookEvent({
      event: "PreInvocation",
      payload: {
        conversationId: "conv-main-session",
        invocationNum: loopTurn,
        lastUserInput: "Antigravity Zephyr Quartz Protocol",
        workspacePaths: [f.project],
      },
      libraryPath: registered.libraryPath,
    });
    assert.equal(skipped, "{}\n");
  }

  // Separate subagent conversation starts at invocationNum: 0 and injects before its first work turn.
  const subagentFirst = await runHookEvent({
    event: "PreInvocation",
    payload: {
      conversationId: "conv-subagent-session",
      invocationNum: 0,
      lastUserInput: "Antigravity Zephyr Quartz Protocol",
      workspacePaths: [f.project],
    },
    libraryPath: registered.libraryPath,
  });
  const parsedSubagentFirst = JSON.parse(subagentFirst);
  assert.ok(parsedSubagentFirst.injectSteps?.[0]?.systemMessage?.systemMessage?.includes("Zephyr Quartz"), subagentFirst);

  const hookLogLines = (await readFile(join(f.deviceHome, "log", "hook.ndjson"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    hookLogLines.map((entry) => entry.reasonCode),
    [
      "HOOK_RECALL_ANSWERED",
      "HOOK_ANTIGRAVITY_INVOCATION_SKIPPED",
      "HOOK_ANTIGRAVITY_INVOCATION_SKIPPED",
      "HOOK_RECALL_ANSWERED",
    ],
  );
});

test("INIT091-A3b: PreToolUse enforces 200-line and 32-KiB Read Guard with JSON stdout on exit 0", async (t) => {
  const f = await fixture(t);
  await mkdirFixture(f);
  process.env.EINZBERN_HOST = "antigravity";
  process.env.EINZBERN_HOME = f.deviceHome;

  // PreToolUse Read Guard: <= 32 KiB allowed; > 32 KiB without range or > 200 lines denied; <= 200 lines within 32 KiB allowed.
  const { AGENT_OUTPUT_MAX_BYTES } = await import("../dist/build/packages/core/src/runtime-input-contract.js");
  const smallFile = join(f.project, "small.txt");
  const multiLineLarge = join(f.project, "large-lines.txt");
  const singleHugeLine = join(f.project, "single-huge-line.txt");
  await writeFile(smallFile, "small\n");
  await writeFile(multiLineLarge, Array.from({ length: 1200 }, (_, index) => `line-${String(index + 1).padStart(4, "0")}-${"x".repeat(30)}`).join("\n") + "\n");
  await writeFile(singleHugeLine, `${"z".repeat(AGENT_OUTPUT_MAX_BYTES + 64)}\n`);

  const allowSmall = JSON.parse(await runHookEvent({
    event: "PreToolUse",
    payload: { toolCall: { name: "read_file", args: { Path: smallFile } }, workspacePaths: [f.project] },
    cwd: f.home,
  }));
  assert.deepEqual(allowSmall, { decision: "allow" });

  const denyWhole = JSON.parse(await runHookEvent({
    event: "PreToolUse",
    payload: { toolCall: { name: "read_file", args: { Path: multiLineLarge } }, workspacePaths: [f.project] },
    cwd: f.home,
  }));
  assert.equal(denyWhole.decision, "deny");
  assert.equal(process.exitCode, oldHookExitCode, "Antigravity PreToolUse deny exits 0 with JSON stdout");

  const denyOver200 = JSON.parse(await runHookEvent({
    event: "PreToolUse",
    payload: { toolCall: { name: "view_file", args: { AbsolutePath: multiLineLarge, StartLine: 10, EndLine: 210 } }, workspacePaths: [f.project] },
    cwd: f.home,
  }));
  assert.equal(denyOver200.decision, "deny");

  const allow200 = JSON.parse(await runHookEvent({
    event: "PreToolUse",
    payload: { toolCall: { name: "read_file", args: { Path: multiLineLarge, StartLine: 1, EndLine: 200 } }, workspacePaths: [f.project] },
    cwd: f.home,
  }));
  assert.deepEqual(allow200, { decision: "allow" });

  const denyByteOverflow = JSON.parse(await runHookEvent({
    event: "PreToolUse",
    payload: { toolCall: { name: "read_file", args: { Path: singleHugeLine, StartLine: 1, EndLine: 1 } }, workspacePaths: [f.project] },
    cwd: f.home,
  }));
  assert.equal(denyByteOverflow.decision, "deny");

  const allowUnknownTool = JSON.parse(await runHookEvent({
    event: "PreToolUse",
    payload: { toolCall: { name: "run_command", args: { CommandLine: `cat ${multiLineLarge}` } }, workspacePaths: [f.project] },
    cwd: f.home,
  }));
  assert.deepEqual(allowUnknownTool, { decision: "allow" });
});
