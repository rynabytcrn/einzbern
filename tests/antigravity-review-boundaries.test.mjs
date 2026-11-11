// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  applyAntigravityHookPlan,
  inspectAntigravityHookScope,
  isOwnedAntigravityHookGroup,
  mergeAntigravityHookDocument,
  planAntigravityHooks,
} from "../dist/build/packages/core/src/antigravity-host.js";
import { runDoctor } from "../dist/build/packages/core/src/doctor.js";
import { createProject, initializeLibrary } from "../dist/build/packages/core/src/index.js";
import { registerLibrary } from "../dist/build/packages/core/src/registry.js";
import { SetupRecorder, applyHooks, planHooks } from "../dist/build/packages/core/src/setup-fresh.js";

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agy-review-boundary-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, home: join(root, "home"), device: join(root, "device") };
}

test("repair A must not leave registered B with global plus local owned hooks", async (t) => {
  const { root, home, device } = await fixture(t);
  const config = join(home, ".gemini/config");
  const a = join(root, "a");
  const b = join(root, "b");
  const library = join(root, "library");
  const original = {
    device: process.env.EINZBERN_HOME,
    config: process.env.ANTIGRAVITY_CONFIG_DIR,
  };
  t.after(() => {
    for (const [key, value] of [
      ["EINZBERN_HOME", original.device],
      ["ANTIGRAVITY_CONFIG_DIR", original.config],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  for (const dir of [config, join(a, ".agents"), join(b, ".agents"), join(device, "engine")]) {
    await mkdir(dir, { recursive: true });
  }
  process.env.EINZBERN_HOME = device;
  process.env.ANTIGRAVITY_CONFIG_DIR = config;
  await writeFile(join(device, "engine/hook.mjs"), "// isolated fixture launcher\n");
  await initializeLibrary({ root: library, createdAt: "2026-11-12T00:00:00Z" });
  for (const [project, name] of [
    [a, "A"],
    [b, "B"],
  ]) {
    const state = await createProject(library, {
      externalKey: name,
      name,
      occurredAt: "2026-11-12T00:00:01Z",
    });
    const projectId = state.projects.find((p) => p.externalKey === name).id;
    await registerLibrary(
      {
        projectPath: project,
        projectId,
        libraryPath: library,
        registeredAt: "2026-11-12T00:00:02Z",
      },
      device,
    );
    // Valid migration input: both registered projects used the supported local scope.
    const doc = mergeAntigravityHookDocument(
      {},
      {
        root: project,
        deviceHome: device,
        userHome: home,
        scope: "project",
        navigation: "always",
        platform: "darwin",
      },
    ).document;
    await writeFile(join(project, ".agents/hooks.json"), JSON.stringify(doc));
  }
  await applyHooks(new SetupRecorder(device, "2026-11-12T00:01:00Z"), {
    home,
    projectRoot: a,
    deviceHome: device,
    at: "2026-11-12T00:01:00Z",
    navigation: "written",
    install: true,
  });
  const host = (
    await runDoctor({
      home,
      deviceHome: device,
      projectRoot: b,
      platform: "darwin",
      env: { ...process.env, ANTIGRAVITY_CONFIG_DIR: config },
    })
  )
    .find((c) => c.check === "hooks-present")
    .detail.hosts.find((h) => h.host === "antigravity");
  const globalCount = (await inspectAntigravityHookScope(config, "user")).count;
  const bCount = (await inspectAntigravityHookScope(b, "project")).count;
  assert.equal(
    Number(globalCount > 0) + Number(bCount > 0),
    1,
    `B must have exactly one effective group; global=${globalCount}, localB=${bCount}, doctor=${JSON.stringify(host.causes)}`,
  );
  assert.equal(host.causes.includes("HOOK_DUPLICATED"), false);
});

test("unchanged POSIX hook generated under a device path containing % stays owned", async (t) => {
  const { root, home, device } = await fixture(t);
  const config = join(root, "config");
  await mkdir(config, { recursive: true });
  const request = {
    root: config,
    userHome: home,
    deviceHome: join(root, "device-20%"),
    scope: "user",
    navigation: "always",
    platform: "darwin",
  };
  const first = await planAntigravityHooks(request);
  await applyAntigravityHookPlan(first, { at: "2026-11-12T00:02:00Z", deviceHome: device });
  // No bytes or settings changed between generation and the ownership check.
  const second = await planAntigravityHooks(request);
  assert.equal(second.changed, false);

  const writtenDoc = JSON.parse(await readFile(join(config, "hooks.json"), "utf8"));
  assert.equal(isOwnedAntigravityHookGroup(writtenDoc.einzbern, "darwin"), true);
  assert.equal(isOwnedAntigravityHookGroup(writtenDoc.einzbern, "linux"), true);
  assert.equal(isOwnedAntigravityHookGroup(writtenDoc.einzbern, "win32"), false);
});

test("sibling registered project preserves unmanaged groups on retirement and blocks before global write when edited", async (t) => {
  const { root, home, device } = await fixture(t);
  const config = join(home, ".gemini/config");
  const a = join(root, "a");
  const b = join(root, "b");
  const library = join(root, "library");
  const original = {
    device: process.env.EINZBERN_HOME,
    config: process.env.ANTIGRAVITY_CONFIG_DIR,
  };
  t.after(() => {
    for (const [key, value] of [
      ["EINZBERN_HOME", original.device],
      ["ANTIGRAVITY_CONFIG_DIR", original.config],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  for (const dir of [config, join(a, ".agents"), join(b, ".agents"), join(device, "engine")]) {
    await mkdir(dir, { recursive: true });
  }
  process.env.EINZBERN_HOME = device;
  process.env.ANTIGRAVITY_CONFIG_DIR = config;
  await writeFile(join(device, "engine/hook.mjs"), "// isolated fixture launcher\n");
  await initializeLibrary({ root: library, createdAt: "2026-11-12T00:00:00Z" });
  for (const [project, name] of [
    [a, "A"],
    [b, "B"],
  ]) {
    const state = await createProject(library, {
      externalKey: name,
      name,
      occurredAt: "2026-11-12T00:00:01Z",
    });
    const projectId = state.projects.find((p) => p.externalKey === name).id;
    await registerLibrary(
      {
        projectPath: project,
        projectId,
        libraryPath: library,
        registeredAt: "2026-11-12T00:00:02Z",
      },
      device,
    );
  }

  // Case 1: sibling B has an edited local einzbern group -> planHooks blocks on B's path and applyHooks writes nothing.
  for (const [project, name] of [
    [a, "A"],
    [b, "B"],
  ]) {
    const initial = name === "B"
      ? { "b-custom": { PostToolUse: [{ matcher: "write_file", hooks: [{ type: "command", command: "echo b", timeout: 10 }] }] } }
      : {};
    const doc = mergeAntigravityHookDocument(initial, {
      root: project,
      deviceHome: device,
      userHome: home,
      scope: "project",
      navigation: "always",
      platform: "darwin",
    }).document;
    if (name === "B") {
      doc.einzbern.PreInvocation[0].command = doc.einzbern.PreInvocation[0].command.replace(
        "process.env.EINZBERN_HOST='antigravity';",
        "process.env.EINZBERN_HOST='antigravity';process.env.SIBLING_CUSTOM='1';",
      );
    }
    await writeFile(join(project, ".agents/hooks.json"), `${JSON.stringify(doc, null, 2)}\n`);
  }
  const bHookPath = join(b, ".agents/hooks.json");
  const bEditedBytes = await readFile(bHookPath, "utf8");

  const planned = new SetupRecorder(device, "2026-11-12T00:01:00Z");
  await planHooks(planned, home, device, "written", true, undefined, false, a);
  assert.ok(
    planned.blockers.some((blocker) => blocker.path === bHookPath && blocker.reasonCode === "ANTIGRAVITY_HOOKS_OWNERSHIP_CONFLICT"),
  );
  await assert.rejects(
    applyHooks(new SetupRecorder(device, "2026-11-12T00:01:10Z"), {
      home,
      projectRoot: a,
      deviceHome: device,
      at: "2026-11-12T00:01:10Z",
      navigation: "written",
      install: true,
    }),
    { reasonCode: "ANTIGRAVITY_HOOKS_OWNERSHIP_CONFLICT" },
  );
  assert.equal((await inspectAntigravityHookScope(config, "user")).count, 0);
  assert.equal(await readFile(bHookPath, "utf8"), bEditedBytes);

  // Case 2: once sibling B's local einzbern group is unedited, migrating A retires B's einzbern group while keeping b-custom.
  const bClean = mergeAntigravityHookDocument(
    { "b-custom": { PostToolUse: [{ matcher: "write_file", hooks: [{ type: "command", command: "echo b", timeout: 10 }] }] } },
    { root: b, deviceHome: device, userHome: home, scope: "project", navigation: "always", platform: "darwin" },
  ).document;
  await writeFile(bHookPath, `${JSON.stringify(bClean, null, 2)}\n`);
  await applyHooks(new SetupRecorder(device, "2026-11-12T00:01:20Z"), {
    home,
    projectRoot: a,
    deviceHome: device,
    at: "2026-11-12T00:01:20Z",
    navigation: "written",
    install: true,
  });
  assert.deepEqual(Object.keys(JSON.parse(await readFile(bHookPath, "utf8"))), ["b-custom"]);
});
