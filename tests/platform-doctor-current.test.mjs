// SPDX-License-Identifier: Apache-2.0
// BL41: actual 2.x library and device fixtures, never the historical platform manifest.
import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectPlatform } from "../scripts/platform-doctor.mjs";
import { FRAMEWORK_VERSION, initializeLibrary, registerLibrary, applyHostHooks, readHostHooks, planHostHooks } from "../dist/build/packages/core/src/index.js";
import { installSkillCopies } from "../dist/build/packages/core/src/skill-copies.js";
import { canonicalJson } from "../dist/build/packages/protocol/src/index.js";

const AT = "2026-10-17T12:00:00Z";
async function fixture(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-platform-current-")));
  const home = join(base, "home");
  const device = join(home, ".einzbern");
  const root = join(base, "container");
  const previous = process.env.EINZBERN_HOME;
  process.env.EINZBERN_HOME = device;
  t.after(async () => {
    if (previous === undefined) delete process.env.EINZBERN_HOME;
    else process.env.EINZBERN_HOME = previous;
    await rm(base, { recursive: true, force: true });
  });
  const scripts = join(device, "engine", FRAMEWORK_VERSION, "scripts");
  await mkdir(scripts, { recursive: true });
  await mkdir(root);
  for (const file of [join(scripts, "einzbern.mjs"), join(scripts, "einzbern-hook.mjs"), join(device, "engine", "einzbern.mjs"), join(device, "engine", "hook.mjs")]) await writeFile(file, "export {};\n");
  await writeFile(join(device, "engine", "current"), canonicalJson({ schemaVersion: "einzbern.engine-current.v1", version: FRAMEWORK_VERSION, previous: null, switchedAt: AT }));
  for (const host of ["claude-code", "codex"]) await applyHostHooks(await readHostHooks(planHostHooks({ host, scope: "user", deviceHome: device }), { root: home, home }), { at: AT });
  const skill = join(base, "skill");
  await mkdir(skill);
  await writeFile(join(skill, "SKILL.md"), "---\nname: mana-orchestrate\ndescription: fixture\n---\n");
  await installSkillCopies({ source: skill, now: AT, home, deviceHome: device });
  const library = join(root, ".ether");
  await initializeLibrary({ root: library, createdAt: AT });
  await registerLibrary({ projectPath: root, libraryPath: library, registeredAt: AT, cloudHosted: false, gitRemote: null }, device);
  const inspect = (options = {}) => inspectPlatform(root, { homeRoot: home, deviceHome: device, lockTimeoutMs: 50, ...options });
  return { root, home, device, library, scripts, inspect };
}

test("BL41: minimal .ether container plus current installed engine is healthy without legacy layout or manifest files", async (t) => {
  const f = await fixture(t);
  const result = await f.inspect();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.checks.map((entry) => entry.name), ["platformRoot", "libraryContainer", "minimalContainer", "engine-version", "hooks-present", "skill-copies", "registry", "library-format", "device-stream", "managed-sections", "cloud-flag", "engineExecutability"]);
  assert.equal(result.observations[0].verified, false, "doctor green does not claim native hook dispatch");
  await mkdir(join(f.root, ".git"));
  assert.equal((await f.inspect()).ok, true, "a project/container need not be outside Git");
});

test("BL41: legacy-only, malformed library, broken bridge and engine syntax fail for current reasons", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "CLAUDE.md"), "@missing.md\n");
  let result = await f.inspect();
  assert.equal(result.checks.find((entry) => entry.name === "minimalContainer").ok, false);
  await rm(join(f.root, "CLAUDE.md"));
  await writeFile(join(f.scripts, "einzbern-hook.mjs"), "const = broken;\n");
  result = await f.inspect();
  assert.equal(result.checks.find((entry) => entry.name === "engineExecutability").ok, false);
  await writeFile(join(f.library, "manifest.json"), "{}\n");
  result = await f.inspect({ includeInstallSurface: false });
  assert.equal(result.checks.find((entry) => entry.name === "libraryContainer").ok, false);
  await rm(f.library, { recursive: true });
  await mkdir(join(f.root, ".tcrn-workspace", "cross-project", "workspace"), { recursive: true });
  result = await f.inspect({ includeInstallSurface: false });
  assert.equal(result.ok, false, "an old-layout directory cannot certify the 2.x default");
  assert.equal(result.reasonCode, "PLATFORM_LIBRARY_INVALID");
});

test("BL41: changed current pointer, missing hooks and removed skill copy are detected", async (t) => {
  const f = await fixture(t);
  await rm(join(f.home, ".claude", "settings.json"));
  let result = await f.inspect();
  assert.equal(result.checks.find((entry) => entry.name === "hooks-present").ok, false);
  await rm(join(f.home, ".agents", "skills", "mana-orchestrate"), { recursive: true });
  result = await f.inspect();
  assert.equal(result.checks.find((entry) => entry.name === "skill-copies").ok, false);
  await writeFile(join(f.device, "engine", "current"), canonicalJson({ schemaVersion: "einzbern.engine-current.v1", version: "99.0.0", previous: null, switchedAt: AT }));
  result = await f.inspect();
  assert.equal(result.checks.find((entry) => entry.name === "engine-version").ok, false);
  assert.equal(result.checks.find((entry) => entry.name === "engineExecutability").ok, false);
});
