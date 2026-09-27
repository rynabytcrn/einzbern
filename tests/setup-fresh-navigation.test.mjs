// TCRN-CROSS-SUB-394: changing fresh setup to declined navigation removes only the managed
// navigation section, installs the pointer hooks, and leaves user text intact.

import assert from "node:assert/strict";
import { copyFile, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import { FRAMEWORK_VERSION, computeInstallTreeDigest, materializeWorkspace } from "../dist/build/packages/core/src/index.js";
import { DOCTOR_CHECKS } from "../dist/build/packages/core/src/doctor.js";
import { parseManagedFile } from "../dist/build/packages/core/src/managed-sections.js";
import { applySetup, planSetup } from "../dist/build/packages/core/src/setup.js";

const repositoryRoot = resolve(import.meta.dirname, "..");

let second = 0;
function at() {
  second += 1;
  return new Date(Date.UTC(2026, 8, 27, 4, 0, second)).toISOString().replace(".000Z", "Z");
}

async function cli(args) {
  let output = "";
  await runCli(args, { write: (value) => { output += value; } });
  return JSON.parse(output);
}

async function engineTree(base) {
  const tree = join(base, "trees", FRAMEWORK_VERSION);
  await mkdir(join(tree, "scripts", "policy"), { recursive: true });
  await copyFile(join(repositoryRoot, "scripts/einzbern.mjs"), join(tree, "scripts/einzbern.mjs"));
  await copyFile(join(repositoryRoot, "scripts/policy/knowledge-provenance.json"), join(tree, "scripts/policy/knowledge-provenance.json"));
  await cp(join(repositoryRoot, "dist/build"), join(tree, "dist/build"), { recursive: true });
  await mkdir(join(tree, "launchers"));
  await copyFile(join(repositoryRoot, "scripts/einzbern-launcher.mjs"), join(tree, "launchers/einzbern.mjs"));
  await copyFile(join(repositoryRoot, "scripts/einzbern-hook-launcher.mjs"), join(tree, "launchers/hook.mjs"));
  const rendered = await cli(["skill-render", "--out", join(tree, "skill", "mana-orchestrate"), "--version", FRAMEWORK_VERSION]);
  assert.equal(rendered.reasonCode, "SKILL_RENDERED");
  return { tree, sha256: (await computeInstallTreeDigest(tree)).sha256 };
}

async function fixture(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-fresh-navigation-")));
  const home = join(base, "home");
  const deviceHome = join(base, "device");
  const project = join(base, "project");
  await mkdir(home, { recursive: true });
  await mkdir(project, { recursive: true });
  const previous = { home: process.env.HOME, profile: process.env.USERPROFILE, device: process.env.EINZBERN_HOME };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.EINZBERN_HOME = deviceHome;
  t.after(async () => {
    for (const [name, value] of [["HOME", previous.home], ["USERPROFILE", previous.profile], ["EINZBERN_HOME", previous.device]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(base, { recursive: true, force: true });
  });
  const engine = await engineTree(base);
  const installed = await cli(["engine-update", "--from", engine.tree, "--sha256", engine.sha256, "--version", FRAMEWORK_VERSION, "--at", at()]);
  assert.equal(installed.reasonCode, "ENGINE_UPDATED");
  return { base, home, deviceHome, project };
}

function freshPlan(f, navigation) {
  return planSetup({
    mode: "fresh",
    projectRoot: f.project,
    at: at(),
    home: f.home,
    deviceHome: f.deviceHome,
    answers: { artifacts: join(f.project, ".ether"), cloud: false, language: "en", navigation },
  });
}

function assertSelfCheck(applied, expected) {
  assert.deepEqual(applied.selfCheck.map((entry) => entry.check), [...DOCTOR_CHECKS]);
  for (const entry of applied.selfCheck) assert.equal(entry.ok, expected, `${entry.check}: ${JSON.stringify(entry.detail)}`);
}

function check(applied, name) {
  return applied.selfCheck.find((entry) => entry.check === name);
}

test("fresh mode removes managed navigation on decline and preserves user prose", async (t) => {
  const f = await fixture(t);
  const agentsPath = join(f.project, "AGENTS.md");
  const userPrefix = "# Project guidance\n\nKeep the team's notes here.\n";
  await writeFile(agentsPath, userPrefix);

  const first = await applySetup(await freshPlan(f, true));
  assert.equal(first.reasonCode, "SETUP_APPLIED");
  const firstText = await readFile(agentsPath, "utf8");
  assert.ok(firstText.startsWith(userPrefix));
  assert.ok(parseManagedFile(firstText, "AGENTS.md").sections.some((section) => section.id === "navigation"));

  const userSuffix = "\n# Local additions\nPreserve this paragraph byte for byte.\n";
  await writeFile(agentsPath, `${firstText}${userSuffix}`);
  const beforeDecline = await readFile(agentsPath, "utf8");
  const navigation = parseManagedFile(beforeDecline, "AGENTS.md").sections.find((section) => section.id === "navigation");
  assert.ok(navigation);

  const declinedPlan = await freshPlan(f, false);
  assert.ok(declinedPlan.writes.some((entry) => entry.step === "managed-sections" && entry.path === agentsPath && entry.action === "update"));
  assert.ok(declinedPlan.backups.some((entry) => entry.path === agentsPath));
  assert.ok(declinedPlan.writes.some((entry) => entry.step === "host-hooks" && entry.path === join(f.home, ".claude", "settings.json")));

  const declined = await applySetup(declinedPlan);
  assert.equal(declined.reasonCode, "SETUP_APPLIED");
  assert.equal(await readFile(agentsPath, "utf8"), beforeDecline.replace(`${navigation.raw}\n`, ""));
  assertSelfCheck(declined, true);
  const hooksCheck = check(declined, "hooks-present");
  assert.ok(hooksCheck.detail.hosts.every((host) => host.hooks === 1));
  const claudeHooks = JSON.parse(await readFile(join(f.home, ".claude", "settings.json"), "utf8")).hooks;
  assert.deepEqual(Object.keys(claudeHooks).sort(), ["SessionStart", "SubagentStart", "UserPromptSubmit"]);
  assert.equal(JSON.parse(await readFile(join(f.deviceHome, "machine-settings.json"), "utf8")).values["agents.navigation"], "declined");
  const state = await materializeWorkspace(join(f.project, ".ether"));
  assert.equal(state.configRecords.some((record) => record.collection === "managed-section" && record.key === "AGENTS.md#navigation"), false);

  // A later decline leaves a user-edited navigation block in place and reports it as pending.
  const acceptedAgain = await applySetup(await freshPlan(f, true));
  assert.equal(acceptedAgain.reasonCode, "SETUP_APPLIED");
  const beforeEdit = await readFile(agentsPath, "utf8");
  const managedNavigation = parseManagedFile(beforeEdit, "AGENTS.md").sections.find((section) => section.id === "navigation");
  assert.ok(managedNavigation);
  const editedText = beforeEdit.replace(managedNavigation.raw, managedNavigation.raw.replace("This project is managed by Einzbern.", "The team edited this navigation section."));
  await writeFile(agentsPath, editedText);

  const editedDeclinePlan = await freshPlan(f, false);
  assert.ok(editedDeclinePlan.pendingSections.some((section) => section.file === "AGENTS.md" && section.id === "navigation"));
  const editedDecline = await applySetup(editedDeclinePlan);
  assert.equal(await readFile(agentsPath, "utf8"), editedText);
  assert.equal(check(editedDecline, "hooks-present").ok, true);
  assert.equal(check(editedDecline, "managed-sections").ok, false);
  assert.ok(check(editedDecline, "managed-sections").detail.causes.includes("MANAGED_SECTION_PENDING"));
});
