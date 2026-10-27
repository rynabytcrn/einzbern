// SPDX-License-Identifier: Apache-2.0

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nodeTest from "node:test";

// Each test owns a private synthetic platform root. Registering those independent roots
// under one concurrent suite removes the serial fixture/doctor startup tail without
// changing a test name, assertion, or behavior vector.
const queuedTests = [];
const platformDoctorConcurrency = Number(
  process.env.TCRN_PLATFORM_DOCTOR_TEST_CONCURRENCY
    ?? (process.env.TCRN_TEST_CONTROLLER_PROCESS_GROUP ? 1 : 2),
);
function test(name, optionsOrBody, maybeBody) {
  const options = typeof optionsOrBody === "function" ? {} : optionsOrBody ?? {};
  const body = typeof optionsOrBody === "function" ? optionsOrBody : maybeBody;
  queuedTests.push([name, { ...options, concurrency: true }, body]);
}

import { coreExportedSymbols, inspectChainValidation, inspectLegacyPlatform as inspectPlatform } from "../scripts/platform-doctor.mjs";
import { HOST_HOOK_FILE_HOSTS, mergeHostHooks, planHostHooks } from "../dist/build/packages/core/src/host-hooks.js";
import { BRAND, DEVICE_HOME_ENTRIES, DIRECTORY, INSTALL_MANIFEST, LEGACY_CONTROL_DIRECTORY, WORKSPACE_STORAGE_MIGRATION_SEGMENT_BYTES, LEGACY_BRAND_NAME, LEGACY_ENGINE_NAME, LOCAL_DIRECTORY_NAMES, initializeLibrary, materializeWorkspace, workspaceBudgets } from "../dist/build/packages/core/src/index.js";
import { PROTOCOL_LIMITS } from "../dist/build/packages/protocol/src/index.js";

const FIXTURE_COMMIT = "f".repeat(40);
const launchdLabel = "com.tcrn.platform.local-snapshot";

async function fixture(context, { agents = "fixture\n", chain = true, git = false, whitelistGit = false, claude = "@AGENTS.md\n" } = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-platform-doctor-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "platform");
  await mkdir(root, { recursive: true });
  if (agents !== null) await writeFile(join(root, "AGENTS.md"), agents);
  if (claude !== null) await writeFile(join(root, "CLAUDE.md"), claude);
  if (chain) {
    const control = join(root, ".tcrn-workspace", "cross-project", "workspace", LEGACY_CONTROL_DIRECTORY);
    await mkdir(control, { recursive: true });
    await writeFile(join(control, "workspace.json"), JSON.stringify({ storageVersion: 2, segmentEventLimit: WORKSPACE_STORAGE_MIGRATION_SEGMENT_BYTES }));
  }
  if (git) {
    await mkdir(join(root, ".git"));
    if (whitelistGit) await writeFile(join(root, ".gitignore"), "/*\n!/AGENTS.md\n!/CLAUDE.md\n!/docs/\n");
  }
  return root;
}

test("missing legacy workspace metadata is a storage refusal, not a healthy fixture", async (context) => {
  const root = await fixture(context);
  await rm(join(root, ".tcrn-workspace", "cross-project", "workspace", LEGACY_CONTROL_DIRECTORY, "workspace.json"));
  const result = await inspectPlatform(root, { includeInstallSurface: false });
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, "PLATFORM_WORKSPACE_STORAGE_BEHIND");
  const storage = result.checks.find((entry) => entry.name === "workspaceStorageShape");
  assert.equal(storage.partitions[0].error, "ENOENT");
});

test("a complete synthetic platform container is green", async (context) => {
  const root = await fixture(context);
  const result = await inspectPlatform(root, { includeInstallSurface: false });
  assert.equal(result.ok, true);
  assert.equal(result.reasonCode, "PLATFORM_LAYOUT_HEALTHY");
  assert.deepEqual(result.checks.map((item) => item.ok), [true, true, true, true, true, true]);
});

test("STORY-371: Claude's bridge is exact and arbitrary prose is red", async (context) => {
  const invalid = await fixture(context, { claude: "@OTHER.md\n" });
  const red = await inspectPlatform(invalid, { includeInstallSurface: false });
  const redBridge = red.checks.find((entry) => entry.name === "claudeBridge");
  assert.equal(redBridge.ok, false);
  assert.equal(redBridge.reasonCode, "PLATFORM_CLAUDE_BRIDGE_INVALID");

  const whitespace = await fixture(context, { claude: " @AGENTS.md \n\n" });
  const green = await inspectPlatform(whitespace, { includeInstallSurface: false });
  assert.equal(green.checks.find((entry) => entry.name === "claudeBridge").ok, true);
});

// TCRN-CROSS-SUB-376 (STORY-491 R2). The leg that required a topology section in the container
// AGENTS.md and the leg that held it byte-equal to a tracked copy in the platform documents retire
// with the layout rendering pipeline. Neither is reported on either surface, a container with
// neither the section nor the copy is green (no fixture here writes the copy any more), and every
// other leg keeps its name, order and reason code: an AGENTS.md that CLAUDE.md imports and that is
// gone is still named, by the bridge leg. Red leg: restore either leg and the name list grows.
test("SUB-376: the container AGENTS.md topology and tracked-copy legs are retired", async (context) => {
  const retired = ["platformAgents", "platformAgentsHistory"];
  const root = await fixture(context, { agents: "identity retained, no topology section\n" });
  const result = await inspectPlatform(root, { includeInstallSurface: false });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.checks.map((item) => item.name), [
    "platformRoot", "workspaceContainer", "workspaceStorageShape", "containerOutsideGit", "claudeBridge", "bridgeSyntax",
  ]);

  const missing = await fixture(context, { agents: null });
  const missingResult = await inspectPlatform(missing, { includeInstallSurface: false });
  assert.equal(missingResult.ok, false);
  assert.equal(missingResult.reasonCode, "PLATFORM_BRIDGE_TARGET_UNAVAILABLE");
  assert.deepEqual(missingResult.checks.find((item) => item.name === "bridgeSyntax").failures.map(({ path, target }) => ({ path, target })), [{ path: "CLAUDE.md", target: "AGENTS.md" }]);
  assert.deepEqual(missingResult.checks.filter((item) => retired.includes(item.name)), []);

  const install = await completeInstallFixture(context);
  const installResult = await inspectInstallFixture(install);
  assert.equal(installResult.ok, true, JSON.stringify(installResult.checks.filter((item) => !item.ok)));
  assert.deepEqual(installResult.checks.filter((item) => retired.includes(item.name)), []);
});

// TCRN-CROSS-SUB-373 (STORY-490 R3). The acceptance roster and its recorded verdicts left the
// platform documents for the archive; machine-judged work is decided by the gates a project
// declares in its library and the gates-run results that cover it (TCRN-CROSS-STORY-485). The
// doctor reports neither leg on either surface and reads neither file: a container with no
// platform-docs directory is green, and so is one whose roster file is not a roster at all.
// Red leg: restore either leg and the second container goes red.
test("SUB-373: the acceptance roster and verdict legs are retired", async (context) => {
  const retired = ["acceptanceGateGroups", "acceptanceVerdicts"];
  const root = await fixture(context);
  const result = await inspectPlatform(root, { includeInstallSurface: false });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.checks.filter((item) => retired.includes(item.name)), []);
  assert.equal(JSON.stringify(result).includes("PLATFORM_ACCEPTANCE_"), false);

  const install = await completeInstallFixture(context);
  await mkdir(join(install.root, "platform-docs"), { recursive: true });
  await writeFile(join(install.root, "platform-docs", "acceptance-gate-groups.json"), "not a roster\n");
  const installResult = await inspectInstallFixture(install);
  assert.equal(installResult.ok, true, JSON.stringify(installResult.checks.filter((item) => !item.ok)));
  assert.deepEqual(installResult.checks.filter((item) => retired.includes(item.name)), []);
  assert.equal(JSON.stringify(installResult).includes("PLATFORM_ACCEPTANCE_"), false);
});

test("a missing chain container is a distinct red leg", async (context) => {
  const root = await fixture(context, { chain: false });
  const result = await inspectPlatform(root, { includeInstallSurface: false });
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, "WORKSPACE_CONTAINER_MISSING");
});

test("a container inside Git ancestry is refused", async (context) => {
  const root = await fixture(context, { git: true });
  const result = await inspectPlatform(root, { includeInstallSurface: false });
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, "PLATFORM_ROOT_INSIDE_GIT_REPOSITORY");
  assert.equal(result.checks.find((item) => item.name === "containerOutsideGit").ok, false);
});

test("the container whitelist repository is allowed, while code-repository ancestry is not", async (context) => {
  const root = await fixture(context, { git: true, whitelistGit: true });
  const result = await inspectPlatform(root, { includeInstallSurface: false });
  const leg = result.checks.find((item) => item.name === "containerOutsideGit");
  assert.equal(leg.ok, true, JSON.stringify(leg));
  assert.equal(leg.repository, "container-whitelist");
});

test("a missing Claude bridge is named separately", async (context) => {
  const root = await fixture(context, { claude: null });
  const result = await inspectPlatform(root, { includeInstallSurface: false });
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, "PLATFORM_CLAUDE_BRIDGE_MISSING");
});

test("a missing --platform-root argument fails closed", async () => {
  const result = await inspectPlatform();
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, "PLATFORM_ROOT_REQUIRED");
});

test("S259 bridge syntax is green when root and direct-child references resolve", async (context) => {
  const root = await fixture(context, { claude: "@AGENTS.md\n" });
  await mkdir(join(root, "classification"));
  await writeFile(join(root, "classification", "AGENTS.md"), "@../AGENTS.md\n");
  const result = await inspectPlatform(root, { includeInstallSurface: false });
  const bridge = result.checks.find((item) => item.name === "bridgeSyntax");
  assert.equal(result.ok, true);
  assert.equal(bridge.ok, true);
  assert.equal(bridge.source, "platform-and-direct-child-bridges");
});

test("S259 bridge syntax names a double-at reference independently", async (context) => {
  const root = await fixture(context, { claude: "@@\n" });
  const result = await inspectPlatform(root, { includeInstallSurface: false });
  const bridge = result.checks.find((item) => item.name === "bridgeSyntax");
  assert.equal(bridge.reasonCode, "PLATFORM_BRIDGE_SYNTAX_INVALID");
  assert.equal(bridge.failures[0].path, "CLAUDE.md");
  assert.equal(bridge.failures[0].line, 1);
});

test("S259 bridge syntax names a dangling target independently", async (context) => {
  const root = await fixture(context, { claude: "@missing-bridge.md\n" });
  const result = await inspectPlatform(root, { includeInstallSurface: false });
  const bridge = result.checks.find((item) => item.name === "bridgeSyntax");
  assert.equal(bridge.reasonCode, "PLATFORM_BRIDGE_TARGET_UNAVAILABLE");
  assert.equal(bridge.failures[0].path, "CLAUDE.md");
  assert.equal(bridge.failures[0].target, "missing-bridge.md");
});

test("S259 bridge syntax skips hidden directories and the workspace container", async (context) => {
  const root = await fixture(context);
  await mkdir(join(root, ".hidden"));
  await writeFile(join(root, ".hidden", "CLAUDE.md"), "@missing-hidden.md\n");
  await writeFile(join(root, ".tcrn-workspace", "CLAUDE.md"), "@missing-workspace.md\n");
  const result = await inspectPlatform(root, { includeInstallSurface: false });
  assert.equal(result.ok, true);
  assert.equal(result.checks.find((item) => item.name === "bridgeSyntax").ok, true);
});

async function completeInstallFixture(context, { engineVersion = "0.11.15", helperVersion = "0.11.15", helperPin = `Targets ${LEGACY_BRAND_NAME}`, harness = true } = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-init033-doctor-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "platform");
  const home = join(base, "home");
  // The managed engine copy sits inside the device directory the manifest names.
  const managedRepoRoot = join(home, DIRECTORY.device, LEGACY_ENGINE_NAME);
  await mkdir(join(root, ".tcrn-workspace", "cross-project", "workspace"), { recursive: true });
  await mkdir(home, { recursive: true });
  for (const entry of INSTALL_MANIFEST.items) {
    const path = entry.pathTemplate.replaceAll("<PLATFORM_ROOT>", root).replaceAll("<HOME>", home);
    if (entry.acceptanceProbe.startsWith("probe:regular-directory") || entry.acceptanceProbe.startsWith("probe:engine-version")) await mkdir(path, { recursive: true });
    else {
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, "{}\n");
      if (entry.acceptanceProbe.startsWith("probe:regular-executable")) await chmod(path, 0o755);
    }
  }
  // TCRN-CROSS-INIT-053 R47-06: a complete device directory holds the registry beside engine/current;
  // a launcher hook whose device lacks either one is PLATFORM_HOOK_ENGINE_NOT_INSTALLED.
  await writeFile(join(home, DIRECTORY.device, DEVICE_HOME_ENTRIES.registry), `${JSON.stringify({ schemaVersion: "einzbern.registry.v1", entries: [] })}\n`);
  // TCRN-CROSS-INC-220: a complete install now includes each host's harness, because
  // Owner ruled a host is under the harness from the moment it installs its adapter. The
  // fixture's idea of "complete" moves with that ruling rather than around it.
  if (harness) {
    // TCRN-CROSS-STORY-477 R1: the harness is one hook per host, running the stable launcher in
    // the fixture's own device directory. The launcher is stubbed there, so both renderings point
    // at a file that exists and passes `node --check` rather than reaching into the developer's
    // real device directory. A fixture whose hook names an absent target would red on
    // executability and teach nothing about coverage.
    const deviceHome = join(home, DIRECTORY.device);
    for (const host of HOST_HOOK_FILE_HOSTS) {
      const expected = planHostHooks({ host, scope: "project", deviceHome });
      await mkdir(join(expected.launcher, ".."), { recursive: true });
      await writeFile(expected.launcher, "export {}\n");
      await mkdir(join(root, expected.hooksFile, ".."), { recursive: true });
      await writeFile(join(root, expected.hooksFile), `${JSON.stringify(mergeHostHooks(null, expected).document, null, 2)}\n`);
    }
  }
  await writeFile(join(root, "AGENTS.md"), "fixture\n");
  await writeFile(join(root, "CLAUDE.md"), "@AGENTS.md\n");
  await mkdir(managedRepoRoot, { recursive: true });
  await writeFile(join(managedRepoRoot, "package.json"), `${JSON.stringify({ version: engineVersion })}\n`);
  for (const host of [".agents", ".claude"]) {
    await mkdir(join(home, host, "skills", BRAND.helper.id), { recursive: true });
    await writeFile(join(home, host, "skills", BRAND.helper.id, "SKILL.md"), `${helperPin} \`v${helperVersion}\`\n`);
  }
  return { root, home };
}

// TCRN-CROSS-INIT-053 R47-07: a complete fixture teaches every key of a synthetic catalog. Its chain
// container is empty, so the engine's catalog cannot be read there; these cases passed through the
// unreadable branch while it was green, and that branch is red now. A case about it says so itself.
// R48 (PB-2): the same holds for the engine floor. A complete fixture's one chain reads and declares
// no engine.requiredVersion (UNDECLARED, green by design); the unreadable declaration is red now,
// and the cases about it say so themselves.
const FIXTURE_SETTING_KEYS = Object.freeze(["backup.cadence", "design.authority"]);
const inspectInstallFixture = (fixture, options = {}) => inspectPlatform(fixture.root, {
  homeRoot: fixture.home,
  launchdLabels: [launchdLabel],
  acceptanceHeadCommit: FIXTURE_COMMIT,
  helperSettingKeys: { catalog: FIXTURE_SETTING_KEYS, taught: FIXTURE_SETTING_KEYS },
  engineRequiredVersions: { "cross-project": null },
  ...options,
});

test("S264 four install-completeness legs are green on a synthetic full fixture", async (context) => {
  const fixture = await completeInstallFixture(context);
  const result = await inspectInstallFixture(fixture);
  assert.equal(result.ok, true);
  assert.deepEqual(["helperCopies", "installWiring", "hooks", "deploymentFreshness"].map((name) => result.checks.find((item) => item.name === name).ok), [true, true, true, true]);
});

test("INC-351: freshness accepts the three closed Helper pin forms", async (context) => {
  const forms = [`Supports ${LEGACY_BRAND_NAME}`, `Targets ${LEGACY_BRAND_NAME}`, `Targets the ${LEGACY_BRAND_NAME}`];
  for (const helperPin of forms) {
    const fixture = await completeInstallFixture(context, { engineVersion: "1.1.2", helperVersion: "1.1.2", helperPin });
    const result = await inspectInstallFixture(fixture);
    const freshness = result.checks.find((item) => item.name === "deploymentFreshness");
    assert.equal(freshness.ok, true, `${helperPin}: ${JSON.stringify(freshness)}`);
    assert.equal(freshness.versions.engineVersion, "1.1.2");
    assert.deepEqual(freshness.versions.helpers.map((helper) => helper.version), ["1.1.2", "1.1.2"]);
  }
});

test("INC-351: missing, malformed, and conflicting Helper pins are red", async (context) => {
  const cases = [
    { helperPin: "Targets the Wrong Workflow", expected: "PLATFORM_DEPLOYMENT_VERSION_MISSING" },
    { helperPin: `Targets the ${LEGACY_BRAND_NAME} \`v\``, expected: "PLATFORM_DEPLOYMENT_VERSION_MISSING" },
    { helperPin: `Targets the ${LEGACY_BRAND_NAME} v1.1.2`, expected: "PLATFORM_DEPLOYMENT_VERSION_MISSING" },
    { helperPin: `Supports ${LEGACY_BRAND_NAME} \`v1.1.2\`\nTargets ${LEGACY_BRAND_NAME} \`v1.1.3\``, expected: "PLATFORM_DEPLOYMENT_VERSION_MISSING" },
  ];
  for (const testCase of cases) {
    const fixture = await completeInstallFixture(context, { engineVersion: "1.1.2", helperVersion: "1.1.2", helperPin: testCase.helperPin });
    const result = await inspectInstallFixture(fixture);
    const freshness = result.checks.find((item) => item.name === "deploymentFreshness");
    assert.equal(freshness.ok, false, `${testCase.helperPin}: ${JSON.stringify(freshness)}`);
    assert.equal(freshness.reasonCode, testCase.expected);
  }
});

test("S264 each install-completeness leg has a distinct synthetic red reason", async (context) => {
  const wiring = await completeInstallFixture(context);
  const wiringResult = await inspectInstallFixture(wiring);
  // INC-207 moved the harness to the container root, so the deleted item is a
  // container one now; joi-button no longer carries a declared settings file.
  await rm(join(wiring.root, ".claude", "settings.json"));
  const wiringRed = await inspectInstallFixture(wiring);
  assert.equal(wiringResult.ok, true);
  assert.equal(wiringRed.reasonCode, "PLATFORM_INSTALL_WIRING_INCOMPLETE");

  const stale = await completeInstallFixture(context, { engineVersion: "0.11.14" });
  const staleRed = await inspectInstallFixture(stale);
  assert.equal(staleRed.reasonCode, "PLATFORM_DEPLOYMENT_STALE");

  const helper = await completeInstallFixture(context);
  await rm(join(helper.home, ".agents", "skills", BRAND.helper.id), { recursive: true, force: true });
  const helperRed = await inspectInstallFixture(helper);
  assert.equal(helperRed.reasonCode, "PLATFORM_HELPER_COPIES_INCOMPLETE");

  const launchd = await completeInstallFixture(context);
  const launchdRed = await inspectInstallFixture(launchd, { launchdLabels: [] });
  assert.equal(launchdRed.reasonCode, "PLATFORM_LAUNCHD_NOT_ON_DUTY");
});

test("INC-206 an undeclared harness inside the governed area is red, and an unrelated project's is not", async (context) => {
  const fixture = await completeInstallFixture(context);
  const surface = (result) => result.checks.find((entry) => entry.name === "harnessSurface");

  const green = await inspectInstallFixture(fixture);
  assert.equal(surface(green).ok, true);

  // The classification folder is governed by position: it is on the path from the
  // container root to declared projects. This is the exact shape that sat live and
  // unseen for four days after the container moved.
  await mkdir(join(fixture.root, "TCRN Platform", ".claude"), { recursive: true });
  await writeFile(join(fixture.root, "TCRN Platform", ".claude", "settings.json"), "{}\n", "utf8");
  const strayRed = await inspectInstallFixture(fixture);
  assert.equal(surface(strayRed).ok, false);
  assert.equal(surface(strayRed).reasonCode, "PLATFORM_HARNESS_UNDECLARED");
  assert.ok(surface(strayRed).undeclared.includes(join("TCRN Platform", ".claude")));
  await rm(join(fixture.root, "TCRN Platform", ".claude"), { recursive: true, force: true });

  // The container also holds projects this platform does not govern. Reporting their
  // harness would train the reader to skip the leg, so the governed area is derived
  // from the manifest's own project roots rather than from "everything below here".
  await mkdir(join(fixture.root, "unrelated-project", ".claude"), { recursive: true });
  await writeFile(join(fixture.root, "unrelated-project", ".claude", "settings.json"), "{}\n", "utf8");
  const unrelated = await inspectInstallFixture(fixture);
  assert.equal(surface(unrelated).ok, true, "an unrelated project's own harness is not the platform's business");
});

// TCRN-CROSS-SUB-274 (MIN-235 D3, R14 revision): the lawful declaration of the host-specific state
// the acceptance roster recorded (archived with STORY-490 R3). A declared project's .claude that holds only the per-host local settings file
// git ignores is PLATFORM_HARNESS_HOST_LOCAL: still red and recorded raw, but told apart from an
// undeclared managed harness. Git answers whether the file is ignored, here through the repository's
// own exclude file, so the answer does not depend on the global excludes of the host running the
// test. A tracked copy of the same file, or anything beside it, is managed content.
test("SUB-274 R14: a .claude holding only a git-ignored per-host local file is a host-specific raw result, and managed content stays undeclared", async (context) => {
  const fixture = await completeInstallFixture(context);
  const surface = (result) => result.checks.find((entry) => entry.name === "harnessSurface");
  const project = join(fixture.root, LOCAL_DIRECTORY_NAMES.engine);
  const harness = join(project, ".claude");
  await mkdir(harness, { recursive: true });
  execFileSync("git", ["init", "--quiet", project]);
  await mkdir(join(project, ".git", "info"), { recursive: true });
  await writeFile(join(project, ".git", "info", "exclude"), ".claude/settings.local.json\n");
  await writeFile(join(harness, "settings.local.json"), "{}\n");

  const hostLocal = surface(await inspectInstallFixture(fixture));
  assert.equal(hostLocal.ok, false, "the host-specific state is recorded raw, never turned green");
  assert.equal(hostLocal.reasonCode, "PLATFORM_HARNESS_HOST_LOCAL");
  assert.deepEqual(hostLocal.hostLocal, [join(LOCAL_DIRECTORY_NAMES.engine, ".claude", "settings.local.json")]);
  assert.equal(hostLocal.undeclared, undefined);

  // Managed content beside the local file makes the root an undeclared harness again.
  await writeFile(join(harness, "settings.json"), "{}\n");
  const managed = surface(await inspectInstallFixture(fixture));
  assert.equal(managed.ok, false);
  assert.equal(managed.reasonCode, "PLATFORM_HARNESS_UNDECLARED");
  assert.deepEqual(managed.undeclared, [join(LOCAL_DIRECTORY_NAMES.engine, ".claude")]);
  await rm(join(harness, "settings.json"));

  // A tracked copy of the local file is managed content as well: git no longer ignores it.
  execFileSync("git", ["-C", project, "add", "--force", ".claude/settings.local.json"]);
  const tracked = surface(await inspectInstallFixture(fixture));
  assert.equal(tracked.reasonCode, "PLATFORM_HARNESS_UNDECLARED");
  assert.deepEqual(tracked.undeclared, [join(LOCAL_DIRECTORY_NAMES.engine, ".claude")]);
  execFileSync("git", ["-C", project, "rm", "--cached", "--quiet", ".claude/settings.local.json"]);

  // Not a requirement of every host: a project without the local file has nothing to report.
  await rm(harness, { recursive: true, force: true });
  assert.equal(surface(await inspectInstallFixture(fixture)).ok, true);
});

test("INC-195 the snapshot train is owed only when a chain declares an automatic cadence", async (context) => {
  const fixture = await completeInstallFixture(context);
  const partitions = ["cross-project", "TCRN-AOS", "TCRN-Design-System", "TCRN-TMS", "Joi-Button"];
  const allManual = Object.fromEntries(partitions.map((name) => [name, "manual"]));
  const launchd = (result) => result.checks.find((entry) => entry.name === "launchd");

  // Declared manual: an off-duty train is the declaration being honoured, not a
  // defect. Green, but it has to say so — a silent pass would be the roster-shaped
  // outcome Owner ruled against.
  const manual = await inspectInstallFixture(fixture, { launchdLabels: [], declaredBackupCadence: allManual });
  assert.equal(launchd(manual).ok, true);
  assert.equal(launchd(manual).reasonCode, "PLATFORM_BACKUP_DECLARED_MANUAL");
  assert.equal(launchd(manual).onDuty, false);
  assert.equal(launchd(manual).freshnessAsserted, false);
  // "supplied" rather than "chain-declaration": the field distinguishes a value
  // this fixture injected from one actually read off a chain, so a synthetic run
  // can never be mistaken for evidence about the real platform.
  assert.equal(launchd(manual).cadenceSource, "supplied");

  // Either automatic cadence still owes a train.
  for (const cadence of ["gate-close", "session-end"]) {
    const automatic = await inspectInstallFixture(fixture, {
      launchdLabels: [],
      declaredBackupCadence: { ...allManual, "TCRN-AOS": cadence },
    });
    assert.equal(launchd(automatic).ok, false);
    assert.equal(launchd(automatic).reasonCode, "PLATFORM_LAUNCHD_NOT_ON_DUTY");
  }

  // Freshness is asserted only against an automatic expectation; under `manual`
  // the last snapshot is reported rather than required.
  const staleButManual = await inspectInstallFixture(fixture, {
    launchdLabels: [],
    declaredBackupCadence: allManual,
    localSnapshotFreshness: { ok: false, latestAt: "2020-01-01T00:00:00Z", ageHours: 99_999 },
  });
  assert.equal(launchd(staleButManual).ok, true);

  // The declaration may only relax. When it cannot be read the strict
  // expectation stands, and the report names the read as unreadable.
  const unreadable = await inspectInstallFixture(fixture, { launchdLabels: [], engineCli: "/nonexistent/engine.mjs" });
  assert.equal(launchd(unreadable).ok, false);
  assert.equal(launchd(unreadable).reasonCode, "PLATFORM_LAUNCHD_NOT_ON_DUTY");
  assert.equal(launchd(unreadable).cadenceSource, "unreadable");
});

test("S264 manifest mutation is automatically probed by the wiring leg", async (context) => {
  const fixture = await completeInstallFixture(context);
  const extra = {
    id: "project.synthetic-new-surface",
    layer: "project",
    host: "shared",
    pathTemplate: "<PLATFORM_ROOT>/synthetic-new-surface/required.txt",
    writer: "engine-adapter",
    acceptanceProbe: "synthetic probe",
  };
  const manifest = { ...INSTALL_MANIFEST, items: [...INSTALL_MANIFEST.items, extra] };
  const result = await inspectInstallFixture(fixture, { manifest });
  assert.equal(result.reasonCode, "PLATFORM_INSTALL_WIRING_INCOMPLETE");
  assert.equal(result.checks.find((item) => item.name === "installWiring").missing.some((item) => item.id === extra.id), true);
});

test("S267 hook leg expands the container root and checks all four root-bound events", async (context) => {
  const fixture = await completeInstallFixture(context);
  await mkdir(join(fixture.root, "scripts"), { recursive: true });
  await writeFile(join(fixture.root, "scripts", "hook.mjs"), "export {}\n");
  await writeFile(join(fixture.root, ".claude", "settings.json"), JSON.stringify({ hooks: {
    SessionStart: [{ hooks: [{ type: "command", command: 'node "${CLAUDE_PROJECT_DIR}/scripts/hook.mjs"' }] }],
    UserPromptSubmit: [{ hooks: [{ type: "command", command: 'node "${CLAUDE_PROJECT_DIR}/scripts/hook.mjs"' }] }],
    PreToolUse: [{ hooks: [{ type: "command", command: 'node "${CLAUDE_PROJECT_DIR}/scripts/hook.mjs"' }] }],
    Stop: [{ hooks: [{ type: "command", command: 'node "${CLAUDE_PROJECT_DIR}/scripts/hook.mjs"' }] }],
  } }));
  const result = await inspectInstallFixture(fixture);
  const hooks = result.checks.find((item) => item.name === "hooks");
  assert.equal(hooks.ok, true);
  assert.equal(hooks.checked, 4);
  assert.deepEqual(hooks.events, ["PreToolUse", "SessionStart", "Stop", "UserPromptSubmit"]);
});

test("S267 hook leg turns red for a missing target independently", async (context) => {
  const fixture = await completeInstallFixture(context);
  await writeFile(join(fixture.root, ".claude", "settings.json"), JSON.stringify({ hooks: {
    Stop: [{ hooks: [{ type: "command", command: 'node "${CLAUDE_PROJECT_DIR}/scripts/missing.mjs"' }] }],
  } }));
  const result = await inspectInstallFixture(fixture);
  assert.equal(result.reasonCode, "PLATFORM_HOOK_TARGET_UNAVAILABLE");
  assert.equal(result.checks.find((item) => item.name === "hooks").failures[0].event, "Stop");
});

test("S267 missing settings stays a wiring red leg and does not become a hook false green", async (context) => {
  const fixture = await completeInstallFixture(context);
  await rm(join(fixture.root, ".claude", "settings.json"));
  const result = await inspectInstallFixture(fixture);
  assert.equal(result.reasonCode, "PLATFORM_INSTALL_WIRING_INCOMPLETE");
  assert.equal(result.checks.find((item) => item.name === "hooks").ok, true);
  assert.equal(result.checks.find((item) => item.name === "hooks").deferredTo, "installWiring");
});

test("S269 launchd is green only when the manifest duty, exit status, and fresh success state agree", async (context) => {
  const fixture = await completeInstallFixture(context);
  const result = await inspectInstallFixture(fixture, {
    launchdStatus: { lastExitCode: 0 },
    backupFreshness: { ok: true, latestBackupAt: "synthetic", ageHours: 0 },
  });
  const launchd = result.checks.find((item) => item.name === "launchd");
  assert.equal(launchd.ok, true);
  assert.equal(launchd.requiredLabel, launchdLabel);
  assert.equal(result.ok, true);
});

test("S269 launchd recent failure is distinct from absence", async (context) => {
  const fixture = await completeInstallFixture(context);
  const result = await inspectInstallFixture(fixture, {
    launchdStatus: { lastExitCode: 1 },
    backupFreshness: { ok: true, latestBackupAt: "synthetic", ageHours: 0 },
  });
  assert.equal(result.reasonCode, "PLATFORM_LAUNCHD_LAST_RUN_FAILED");
});

test("S269 launchd absence remains its own duty red leg", async (context) => {
  const fixture = await completeInstallFixture(context);
  const result = await inspectInstallFixture(fixture, {
    launchdLabels: [],
    launchdStatus: { lastExitCode: 0 },
    backupFreshness: { ok: true, latestBackupAt: "synthetic", ageHours: 0 },
  });
  assert.equal(result.reasonCode, "PLATFORM_LAUNCHD_NOT_ON_DUTY");
});

test("S269 stale successful-output state is red after a successful scheduler exit", async (context) => {
  const fixture = await completeInstallFixture(context);
  const result = await inspectInstallFixture(fixture, {
    launchdStatus: { lastExitCode: 0 },
    backupFreshness: { ok: false, latestBackupAt: null, ageHours: Number.POSITIVE_INFINITY, stateOk: false },
  });
  assert.equal(result.reasonCode, "PLATFORM_LAUNCHD_SNAPSHOT_STALE");
  assert.equal(result.checks.find((item) => item.name === "launchd").reasonCode, "PLATFORM_LAUNCHD_SNAPSHOT_STALE");
});

test("S269 launchd label mutation is followed from the manifest", async (context) => {
  const fixture = await completeInstallFixture(context);
  const manifest = {
    ...INSTALL_MANIFEST,
    items: INSTALL_MANIFEST.items.map((entry) => entry.id === "machine.launchd-local-snapshot"
      ? { ...entry, acceptanceProbe: "probe:launchd-duty;label=synthetic.launchd;maxAgeHours=26" }
      : entry),
  };
  const result = await inspectInstallFixture(fixture, {
    manifest,
    launchdLabels: ["synthetic.launchd"],
    launchdStatus: { lastExitCode: 0 },
    backupFreshness: { ok: true, latestBackupAt: "synthetic", ageHours: 0 },
  });
  const launchd = result.checks.find((item) => item.name === "launchd");
  assert.equal(launchd.ok, true);
  assert.equal(launchd.requiredLabel, "synthetic.launchd");
});

test("S270 install wiring executes every safe manifest probe, including codex config and three launchers", async (context) => {
  const fixture = await completeInstallFixture(context);
  const result = await inspectInstallFixture(fixture);
  const wiring = result.checks.find((item) => item.name === "installWiring");
  assert.equal(wiring.ok, true);
  assert.equal(wiring.itemCount, INSTALL_MANIFEST.items.length);
  assert.equal(wiring.probes, "safe-manifest-expression");
});

test("S270 lstat plus file-kind probing rejects a directory in a file residence", async (context) => {
  const fixture = await completeInstallFixture(context);
  const config = join(fixture.home, ".codex", "config.toml");
  await rm(config);
  await mkdir(config);
  const result = await inspectInstallFixture(fixture);
  assert.equal(result.reasonCode, "PLATFORM_INSTALL_WIRING_INCOMPLETE");
  assert.equal(result.checks.find((item) => item.name === "installWiring").invalid.find((item) => item.id === "machine.codex-config").reasonCode, "PLATFORM_INSTALL_WIRING_NOT_FILE");
});

test("S270 unsupported acceptanceProbe syntax is a red leg rather than a shell execution", async (context) => {
  const fixture = await completeInstallFixture(context);
  const manifest = {
    ...INSTALL_MANIFEST,
    items: INSTALL_MANIFEST.items.map((entry) => entry.id === "machine.codex-config" ? { ...entry, acceptanceProbe: "node -e arbitrary" } : entry),
  };
  const result = await inspectInstallFixture(fixture, { manifest });
  assert.equal(result.reasonCode, "PLATFORM_INSTALL_WIRING_INCOMPLETE");
  assert.equal(result.checks.find((item) => item.name === "installWiring").invalid.find((item) => item.id === "machine.codex-config").reasonCode, "PLATFORM_ACCEPTANCE_PROBE_INVALID");
});

test("STORY-286 the hook leg reads codex too, and absence is deferral rather than health", async (context) => {
  // The leg only ever read the Claude settings, so a codex host could carry a broken hook
  // while the doctor called the platform healthy. Codex writes an exact .codex/hooks.json
  // at activation; its commands carry resolved absolute paths rather than a placeholder.
  //
  // harness:false on purpose — INC-220 made a complete fixture carry the harness, and the
  // harness shares .codex/hooks.json with activation. This leg is about the state before
  // either has written it, so the scenario now has to be asked for rather than assumed.
  const fixture = await completeInstallFixture(context, { harness: false });
  await mkdir(join(fixture.root, "scripts"), { recursive: true });
  await writeFile(join(fixture.root, "scripts", "hook.mjs"), "export {}\n");
  await writeFile(join(fixture.root, ".claude", "settings.json"), JSON.stringify({ hooks: {
    Stop: [{ hooks: [{ type: "command", command: 'node "${CLAUDE_PROJECT_DIR}/scripts/hook.mjs"' }] }],
  } }));

  // Writing the Codex hooks file is a separate step, so a container with no hooks file
  // has not failed anything — the Codex harness has not been written there yet.
  const absent = await inspectInstallFixture(fixture);
  const absentHooks = absent.checks.find((item) => item.name === "hooks");
  assert.equal(absentHooks.ok, true);
  assert.equal(absentHooks.codex.state, "absent", "not activated is not the same claim as passed");

  await mkdir(join(fixture.root, ".codex"), { recursive: true });
  await writeFile(join(fixture.root, ".codex", "hooks.json"), JSON.stringify({ hooks: {
    SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: `node "${join(fixture.root, "scripts", "hook.mjs")}"` }] }],
  } }));
  const live = await inspectInstallFixture(fixture);
  const liveHooks = live.checks.find((item) => item.name === "hooks");
  assert.equal(liveHooks.ok, true);
  assert.equal(liveHooks.codex.state, "live");
  assert.deepEqual(liveHooks.codex.events, ["SessionStart"]);
});

test("STORY-286 a registered codex hook whose target cannot run turns the leg red", async (context) => {
  // Activation wrote the file, so something is registered and unrunnable — a finding of
  // its own, and distinct from never having been activated.
  const fixture = await completeInstallFixture(context);
  await writeFile(join(fixture.root, ".claude", "settings.json"), JSON.stringify({ hooks: {} }));
  await mkdir(join(fixture.root, ".codex"), { recursive: true });
  await writeFile(join(fixture.root, ".codex", "hooks.json"), JSON.stringify({ hooks: {
    SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: `node "${join(fixture.root, "scripts", "missing.mjs")}"` }] }],
  } }));
  const missing = await inspectInstallFixture(fixture);
  const missingHooks = missing.checks.find((item) => item.name === "hooks");
  assert.equal(missingHooks.ok, false);
  assert.equal(missingHooks.reasonCode, "PLATFORM_HOOK_TARGET_UNAVAILABLE");
  assert.equal(missingHooks.source, "container.codex-hooks");

  await writeFile(join(fixture.root, ".codex", "hooks.json"), "{ not json");
  const invalid = await inspectInstallFixture(fixture);
  const invalidHooks = invalid.checks.find((item) => item.name === "hooks");
  assert.equal(invalidHooks.ok, false);
  assert.equal(invalidHooks.reasonCode, "PLATFORM_CODEX_HOOKS_INVALID");
});

// TCRN-CROSS-INIT-053 R47-06. A hook can point at a script that is gone, or run Einzbern's launcher
// on a device where the engine was never installed; the launcher then ends every prompt quietly.
// Both looked alike from a session: no answer. The leg tells them apart, and reads the user-level
// files too, where both of the harness audit's failures were.
test("R47-06: a launcher hook on a device without the installed engine is its own red, after a missing script", async (context) => {
  const fixture = await completeInstallFixture(context);
  const hooks = (result) => result.checks.find((item) => item.name === "hooks");
  const device = join(fixture.home, DIRECTORY.device);
  assert.equal(hooks(await inspectInstallFixture(fixture)).ok, true, "the complete fixture's launcher hooks reach an installed engine");

  await rm(join(device, DEVICE_HOME_ENTRIES.registry));
  const noRegistry = hooks(await inspectInstallFixture(fixture));
  assert.equal(noRegistry.ok, false);
  assert.equal(noRegistry.reasonCode, "PLATFORM_HOOK_ENGINE_NOT_INSTALLED");
  assert.deepEqual(noRegistry.failures.map((failure) => [failure.source, failure.reasonCode, failure.missing]), [
    ...[1, 2, 3].map(() => ["container.codex-hooks", "PLATFORM_HOOK_ENGINE_NOT_INSTALLED", ["registry.json"]]),
    ...[1, 2, 3].map(() => ["container.claude-settings", "PLATFORM_HOOK_ENGINE_NOT_INSTALLED", ["registry.json"]]),
  ]);
  assert.equal(noRegistry.failures[0].device, device);

  await rm(join(device, "engine", "current"));
  assert.deepEqual(hooks(await inspectInstallFixture(fixture)).failures[0].missing, ["engine/current", "registry.json"]);

  // A guarded old hook whose script is gone joins the same file: it is the first reason, and the
  // engine finding stays listed beside it rather than folded into it.
  const settingsPath = join(fixture.root, ".claude", "settings.json");
  const settings = JSON.parse(await readFile(settingsPath, "utf8"));
  const gone = '"${CLAUDE_PROJECT_DIR}/tools/stop-pact/hook.mjs"';
  settings.hooks.Stop = [{ hooks: [{ type: "command", command: `if [ -f ${gone} ]; then node ${gone}; fi` }] }];
  await writeFile(settingsPath, JSON.stringify(settings));
  // engine/current is also a manifest item, so installWiring is the result's first red; the leg says the rest.
  const both = await inspectInstallFixture(fixture);
  assert.equal(both.reasonCode, "PLATFORM_INSTALL_WIRING_INCOMPLETE");
  assert.equal(hooks(both).reasonCode, "PLATFORM_HOOK_TARGET_UNAVAILABLE");
  assert.deepEqual(hooks(both).failures.map((failure) => [failure.source, failure.event, failure.reasonCode]), [
    ["container.claude-settings", "Stop", "PLATFORM_HOOK_TARGET_UNAVAILABLE"],
    ...["UserPromptSubmit", "SubagentStart", "PreToolUse"].map((event) => ["container.codex-hooks", event, "PLATFORM_HOOK_ENGINE_NOT_INSTALLED"]),
    ...["UserPromptSubmit", "SubagentStart", "PreToolUse"].map((event) => ["container.claude-settings", event, "PLATFORM_HOOK_ENGINE_NOT_INSTALLED"]),
  ]);
});

test("R47-06: the hook leg reads the user-level Claude and Codex files of the given home, Einzbern's hooks only", async (context) => {
  const fixture = await completeInstallFixture(context, { harness: false });
  const hooks = (result) => result.checks.find((item) => item.name === "hooks");
  const device = join(fixture.home, DIRECTORY.device);
  const launcher = planHostHooks({ host: "codex", scope: "user", deviceHome: device }).launcher;
  await mkdir(join(launcher, ".."), { recursive: true });
  await writeFile(launcher, "export {}\n");
  await rm(join(device, DEVICE_HOME_ENTRIES.registry));
  const oldScript = join(fixture.root, LOCAL_DIRECTORY_NAMES.engine, "scripts", "knowledge-inject-hook.mjs");
  await writeFile(join(fixture.home, ".claude", "settings.json"), JSON.stringify({ hooks: {
    UserPromptSubmit: [{ hooks: [{ type: "command", command: `if [ -f "${oldScript}" ]; then node "${oldScript}" --host claude; fi` }] }],
    // The user's own hook is not the platform's to judge, even when its script is missing.
    Stop: [{ hooks: [{ type: "command", command: `node "${join(fixture.home, "own", "notify.mjs")}"` }] }],
  } }));
  await mkdir(join(fixture.home, ".codex"), { recursive: true });
  await writeFile(join(fixture.home, ".codex", "hooks.json"), JSON.stringify(mergeHostHooks(null, planHostHooks({ host: "codex", scope: "user", deviceHome: device })).document));

  const leg = hooks(await inspectInstallFixture(fixture));
  assert.equal(leg.ok, false);
  assert.equal(leg.reasonCode, "PLATFORM_HOOK_TARGET_UNAVAILABLE");
  assert.deepEqual(leg.failures.map((failure) => [failure.source, failure.event, failure.reasonCode]), [
    ["machine.claude-settings", "UserPromptSubmit", "PLATFORM_HOOK_TARGET_UNAVAILABLE"],
    ...["UserPromptSubmit", "SubagentStart", "PreToolUse"].map((event) => ["machine.codex-hooks", event, "PLATFORM_HOOK_ENGINE_NOT_INSTALLED"]),
  ]);
  assert.deepEqual([leg.user.claude.state, leg.user.claude.checked, leg.user.codex.state, leg.user.codex.checked], ["broken", 1, "broken", 3]);
  assert.equal(leg.failures[0].target, oldScript);

  // An absent container Claude file defers that file only; the user-level findings stay red.
  await rm(join(fixture.root, ".claude", "settings.json"));
  const deferred = hooks(await inspectInstallFixture(fixture));
  assert.equal(deferred.ok, false);
  assert.equal(deferred.reasonCode, "PLATFORM_HOOK_TARGET_UNAVAILABLE");

  // With the old hook gone and the engine installed, every file is live again.
  await writeFile(join(fixture.root, ".claude", "settings.json"), "{}\n");
  await writeFile(join(fixture.home, ".claude", "settings.json"), "{}\n");
  await writeFile(join(device, DEVICE_HOME_ENTRIES.registry), `${JSON.stringify({ schemaVersion: "einzbern.registry.v1", entries: [] })}\n`);
  const live = hooks(await inspectInstallFixture(fixture));
  assert.equal(live.ok, true, JSON.stringify(live));
  // This live file still has no supported admission; restoring the engine does
  // not promote the unknown host observation or add the native stop event.
  assert.deepEqual([live.user.claude.state, live.user.codex.state, live.user.codex.events], ["live", "live", ["PreToolUse", "SubagentStart", "UserPromptSubmit"]]);

  await writeFile(join(fixture.home, ".codex", "hooks.json"), "{ not json");
  const invalid = hooks(await inspectInstallFixture(fixture));
  assert.deepEqual([invalid.ok, invalid.reasonCode, invalid.source], [false, "PLATFORM_CODEX_HOOKS_INVALID", "machine.codex-hooks"]);
});

// TCRN-CROSS-MIN-102 批0. The alignment leg has to be able to go red, and it has to
// go red for the one condition that actually bites: a copy older than what a chain
// declares it needs. Its green case is deliberately two different greens — nothing
// declared (enforcing nothing, and saying so) versus declared and satisfied — so a
// run can never report "aligned" when no floor exists to be aligned against.
test("MIN-102 engine alignment names a copy that is behind a chain declaration", async (context) => {
  const fixture = await completeInstallFixture(context);
  const alignment = (result) => result.checks.find((entry) => entry.name === "engineFloorSatisfied");
  const copies = { installed: "0.11.15", worktree: "0.11.15" };

  // Undeclared is green, but never a silent green: the reason code says the leg is
  // enforcing nothing, and requirementAsserted records that in the verdict itself.
  const undeclared = await inspectInstallFixture(fixture, {
    engineCopyVersions: copies,
    engineRequiredVersions: { "cross-project": null },
  });
  assert.equal(alignment(undeclared).ok, true);
  assert.equal(alignment(undeclared).reasonCode, "PLATFORM_ENGINE_REQUIREMENT_UNDECLARED");
  assert.equal(alignment(undeclared).requirementAsserted, false);

  // A satisfied declaration is the other green, and it asserts.
  const satisfied = await inspectInstallFixture(fixture, {
    engineCopyVersions: copies,
    engineRequiredVersions: { "cross-project": "0.11.15" },
  });
  assert.equal(alignment(satisfied).ok, true);
  assert.equal(alignment(satisfied).requirementAsserted, true);
  assert.deepEqual(alignment(satisfied).declaringPartitions, ["cross-project"]);

  // The red leg: one copy behind one partition's floor. Both the partition and the
  // offending copy are named, because "something is stale" is not actionable.
  const behind = await inspectInstallFixture(fixture, {
    engineCopyVersions: { installed: "0.11.15", worktree: "0.12.0" },
    engineRequiredVersions: { "cross-project": "0.12.0" },
  });
  assert.equal(behind.ok, false);
  assert.equal(alignment(behind).ok, false);
  assert.equal(alignment(behind).reasonCode, "PLATFORM_ENGINE_BEHIND_CHAIN");
  assert.deepEqual(alignment(behind).behind, [
    { partition: "cross-project", required: "0.12.0", copy: "installed", version: "0.11.15", reason: "BEHIND" },
  ]);

  // Semantic precedence, not string order: 0.11.15 vs 0.9.0 is the case a lexical
  // compare gets backwards, and it is exactly the shape a real version bump takes.
  const lexicalTrap = await inspectInstallFixture(fixture, {
    engineCopyVersions: { installed: "0.11.15" },
    engineRequiredVersions: { "cross-project": "0.9.0" },
  });
  assert.equal(lexicalTrap.ok, true);
  assert.equal(alignment(lexicalTrap).ok, true);
});

// TCRN-CROSS-INIT-053 R48 (PB-2, the family of R47-07): the floor leg reads each partition's
// declaration through the engine's settings-catalog. A declaration it cannot read is red, still
// named PLATFORM_ENGINE_REQUIREMENT_UNREADABLE with requirementAsserted false: a partition whose
// catalog fails, and a container it cannot list. Chains that read and declare nothing stay green
// (UNDECLARED), and a declaration read through the same path still asserts.
test("R48 PB-2: an engine floor that cannot be read is red, and chains that read and declare nothing stay green", async (context) => {
  const fixture = await completeInstallFixture(context);
  const alignment = (result) => result.checks.find((entry) => entry.name === "engineFloorSatisfied");
  const copies = { installed: "0.11.15", worktree: "0.11.15" };
  const engine = async (name, body) => {
    const path = join(fixture.root, "..", `${name}.mjs`);
    await writeFile(path, body);
    return path;
  };
  const answering = (value) => engine(`catalog-${value ?? "none"}`, `process.stdout.write(JSON.stringify({ settings: [{ key: "engine.requiredVersion", currentValue: ${JSON.stringify(value)} }] }) + "\\n");\n`);
  const real = (cli) => inspectInstallFixture(fixture, { engineCopyVersions: copies, engineRequiredVersions: undefined, engineCli: cli });

  // A partition whose catalog fails: red, naming the partition.
  const failing = await real(await engine("failing", "process.exitCode = 1;\n"));
  assert.equal(failing.ok, false);
  assert.deepEqual([alignment(failing).ok, alignment(failing).reasonCode, alignment(failing).requirementAsserted, alignment(failing).partition, alignment(failing).source],
    [false, "PLATFORM_ENGINE_REQUIREMENT_UNREADABLE", false, "cross-project", "unreadable"]);
  assert.deepEqual(alignment(failing).copies, copies, "the observed copies are still reported");

  // The fixture's own empty workspace through the real engine: its catalog does not read either.
  const unread = await real(undefined);
  assert.deepEqual([alignment(unread).ok, alignment(unread).reasonCode, alignment(unread).requirementAsserted], [false, "PLATFORM_ENGINE_REQUIREMENT_UNREADABLE", false]);

  // Chains that read and declare nothing: green, and still not asserted.
  const undeclared = await real(await answering(null));
  assert.deepEqual([alignment(undeclared).ok, alignment(undeclared).reasonCode, alignment(undeclared).requirementAsserted, alignment(undeclared).source],
    [true, "PLATFORM_ENGINE_REQUIREMENT_UNDECLARED", false, "chain engine.requiredVersion + install-manifest"]);
  assert.deepEqual(alignment(undeclared).partitions, ["cross-project"]);

  // A declaration read through the same path asserts.
  const satisfied = await real(await answering("0.11.15"));
  assert.deepEqual([alignment(satisfied).ok, alignment(satisfied).requirementAsserted, alignment(satisfied).declaringPartitions], [true, true, ["cross-project"]]);

  // A container it cannot list at all: red, with the read error and no partition.
  await rm(join(fixture.root, ".tcrn-workspace"), { recursive: true, force: true });
  const unlisted = await real(await answering("0.11.15"));
  assert.deepEqual([alignment(unlisted).ok, alignment(unlisted).reasonCode, alignment(unlisted).requirementAsserted, alignment(unlisted).partition, alignment(unlisted).error],
    [false, "PLATFORM_ENGINE_REQUIREMENT_UNREADABLE", false, null, "ENOENT"]);
});

// MIN-103. The Helper's own suite used to check its settings teaching against the
// engine by reading a sibling checkout — forbidden by the dependency-direction rule
// and impossible in the Helper's CI, which checks out one repository. It was ENOENT
// there and green locally, so three consecutive pushes were red on a check that
// could only pass on a developer machine. The question is legitimate; the layer was
// wrong. Here both trees are in scope by design, so here is where it is asked.
test("MIN-103 the platform names a setting the placed Helper never teaches", async (context) => {
  const fixture = await completeInstallFixture(context);
  const coverage = (result) => result.checks.find((entry) => entry.name === "helperSettingsCoverage");
  const catalog = ["backup.cadence", "conference.positionBudgetBytes", "design.authority"];

  const taught = await inspectInstallFixture(fixture, {
    helperSettingKeys: { catalog, taught: catalog },
  });
  assert.equal(coverage(taught).ok, true);
  assert.equal(coverage(taught).coverageAsserted, true);

  // The red leg: the engine registered a key and the payload never mentions it, so
  // an operator would meet a setting no guidance covers.
  const gap = await inspectInstallFixture(fixture, {
    helperSettingKeys: { catalog, taught: ["backup.cadence", "design.authority"] },
  });
  assert.equal(gap.ok, false);
  assert.equal(coverage(gap).ok, false);
  assert.equal(coverage(gap).reasonCode, "PLATFORM_HELPER_SETTINGS_UNTAUGHT");
  assert.deepEqual(coverage(gap).untaught, ["conference.positionBudgetBytes"]);

  // A payload teaching more than the catalog registers is not a fault: the Helper
  // may still carry guidance for a key a given engine build does not ship.
  const extra = await inspectInstallFixture(fixture, {
    helperSettingKeys: { catalog, taught: [...catalog, "some.future.key"] },
  });
  assert.equal(coverage(extra).ok, true);
});

// TCRN-CROSS-INIT-053 R47-07 (harness audit B4). Coverage that cannot be read is not coverage: both
// unreadable sides are red, keep their reason codes, and assert nothing.
test("R47-07: an unreadable engine settings catalog is red, and coverage is not asserted", async (context) => {
  const fixture = await completeInstallFixture(context);
  const coverage = (result) => result.checks.find((entry) => entry.name === "helperSettingsCoverage");
  // The fixture's chain container holds no readable workspace, so the engine's catalog cannot be read.
  const real = await inspectInstallFixture(fixture, { helperSettingKeys: undefined });
  assert.equal(real.ok, false);
  assert.deepEqual([coverage(real).ok, coverage(real).reasonCode, coverage(real).coverageAsserted, coverage(real).source],
    [false, "PLATFORM_HELPER_SETTINGS_UNREADABLE", false, "engine settings-catalog + installed helper payload"]);
  const synthetic = coverage(await inspectInstallFixture(fixture, { helperSettingKeys: { catalog: null, taught: [] } }));
  assert.deepEqual([synthetic.ok, synthetic.reasonCode, synthetic.coverageAsserted, synthetic.source], [false, "PLATFORM_HELPER_SETTINGS_UNREADABLE", false, "synthetic"]);
});

test("R47-07: an unreadable helper payload is red, and coverage is not asserted", async (context) => {
  const fixture = await completeInstallFixture(context);
  const result = await inspectInstallFixture(fixture, { helperSettingKeys: { catalog: ["backup.cadence"], taught: null } });
  const leg = result.checks.find((entry) => entry.name === "helperSettingsCoverage");
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, "PLATFORM_HELPER_PAYLOAD_UNREADABLE");
  assert.deepEqual([leg.ok, leg.reasonCode, leg.coverageAsserted, leg.error], [false, "PLATFORM_HELPER_PAYLOAD_UNREADABLE", false, "UNREADABLE"]);
});

// TCRN-CROSS-INC-224. Headroom is reported before the wall, not at it.
//
// The cap moved from 10,000 to 20,000 on measured evidence that replay is linear. That
// buys time rather than removing the ceiling, so the thing worth gating is not the
// ceiling but the moment there is still room to decide what happens at it. INC-224 was
// found by someone counting; this leg is so the next one is found by being told.
test("INC-224: headroom passes below the trigger and names the largest chain", async (context) => {
  const fixture = await completeInstallFixture(context);
  const result = await inspectInstallFixture(fixture, {
    chainEventCounts: { "cross-project": 4316, "TCRN-AOS": 1054, "TCRN-TMS": 243 },
  });
  const leg = result.checks.find((entry) => entry.name === "chainHeadroom");
  assert.equal(leg.ok, true);
  assert.equal(leg.trigger, 15_000);
  assert.deepEqual(leg.largest, { partition: "cross-project", events: 4316 });
});

// Red leg: compare against the ceiling instead of the trigger and this passes at 19,999,
// leaving one event of notice for a decision that needs weeks.
test("INC-224: crossing the trigger is red, with the remaining headroom and whose call it is", async (context) => {
  const fixture = await completeInstallFixture(context);
  const result = await inspectInstallFixture(fixture, {
    chainEventCounts: { "cross-project": 15_001, "TCRN-AOS": 1054 },
  });
  const leg = result.checks.find((entry) => entry.name === "chainHeadroom");
  assert.equal(leg.ok, false);
  assert.equal(leg.reasonCode, "PLATFORM_CHAIN_REVIEW_TRIGGER_REACHED");
  assert.deepEqual(leg.partitions, [{ partition: "cross-project", events: 15_001, headroom: PROTOCOL_LIMITS.maxChainEvents - 15_001 }]);
  // The remedy must say the disposition is Owner's. A red that reads as a chore gets
  // treated as one, and the decision it exists to prompt is not a chore.
  assert.match(leg.remedy, /Owner decision/u);
});

// Red leg: report only the first partition over the trigger and a platform with two
// chains near the wall looks like a platform with one.
test("INC-224: every partition over the trigger is named, largest first", async (context) => {
  const fixture = await completeInstallFixture(context);
  const result = await inspectInstallFixture(fixture, {
    chainEventCounts: { "TCRN-AOS": 16_000, "cross-project": 18_000, "TCRN-TMS": 243 },
  });
  const leg = result.checks.find((entry) => entry.name === "chainHeadroom");
  assert.equal(leg.ok, false);
  assert.deepEqual(leg.partitions.map((entry) => entry.partition), ["cross-project", "TCRN-AOS"]);
});

// TCRN-CROSS-STORY-451 R2: status reported the chain budget against the per-document
// bound (10,000) while this leg measured the same chain against maxChainEvents
// (20,000), so the two readings of one chain disagreed and 10,000 arrived unwarned.
// Red leg: report maxRecords as the budget limit again.
test("STORY-451: the status budget and chainHeadroom report the same chain ceiling", async (context) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-s451-budget-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  await initializeLibrary({ root: join(base, "workspace"), createdAt: "2026-09-23T00:00:00Z" });
  const budgets = workspaceBudgets(await materializeWorkspace(join(base, "workspace")));
  assert.equal(budgets.events.limit, PROTOCOL_LIMITS.maxChainEvents);
  assert.equal(budgets.events.headroomEvents, PROTOCOL_LIMITS.maxChainEvents - budgets.events.count);
  const fixture = await completeInstallFixture(context);
  const result = await inspectInstallFixture(fixture, { chainEventCounts: { "cross-project": budgets.events.count } });
  const leg = result.checks.find((entry) => entry.name === "chainHeadroom");
  assert.equal(leg.ok, true);
  assert.equal(leg.ceiling, budgets.events.limit, "one chain, one ceiling, whichever reading is consulted");
});

test("INC-251: live chain validation enumerates current partitions and reports elapsed time", async (context) => {
  const root = await fixture(context);
  const chainDirectory = [".tcrn", "workspace"].join("-");
  await mkdir(join(root, chainDirectory, "second-partition", "workspace"), { recursive: true });
  const cli = join(root, "synthetic-engine.mjs");
  await writeFile(cli, `
const workspace = process.argv.at(-1);
process.stdout.write(JSON.stringify({ reasonCode: "WORKSPACE_COMMAND_COMPLETED", workspace }) + "\\n");
`);
  const result = await inspectChainValidation(root, { engineCli: cli });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.source, "live engine validate");
  assert.deepEqual(result.partitions.map((entry) => entry.partition), ["cross-project", "second-partition"]);
  assert.equal(result.partitionCount, 2);
  assert.equal(typeof result.durationMs, "number");
  assert.ok(result.durationMs >= 0);
});

test("INC-251: one live partition failure names that partition and reason", async (context) => {
  const root = await fixture(context);
  const chainDirectory = [".tcrn", "workspace"].join("-");
  await mkdir(join(root, chainDirectory, "broken-partition", "workspace"), { recursive: true });
  const cli = join(root, "synthetic-engine.mjs");
  await writeFile(cli, `
const workspace = process.argv.at(-1);
if (workspace.includes("broken-partition")) {
  process.exitCode = 1;
} else {
  process.stdout.write(JSON.stringify({ reasonCode: "WORKSPACE_COMMAND_COMPLETED" }) + "\\n");
}
`);
  const result = await inspectChainValidation(root, { engineCli: cli });
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, "PLATFORM_CHAIN_VALIDATION_FAILED");
  assert.deepEqual(result.failed.map((entry) => entry.partition), ["broken-partition"]);
  assert.equal(result.failed[0].reasonCode, "PLATFORM_CHAIN_VALIDATE_EXIT_1");
});

// TCRN-CROSS-STORY-361. A container that only consumes this engine has no packages/core
// to walk. Red leg: judge on the
// directory existing rather than on the policy file being readable, and the leg starts
// reading whatever core-export-consumers.json happens to sit on the machine running
// the suite.
test("unusedExports is neutral when the platform root carries no core-export consumer policy", async (context) => {
  const fixture = await completeInstallFixture(context);
  const result = await inspectInstallFixture(fixture);
  const leg = result.checks.find((entry) => entry.name === "unusedExports");
  assert.equal(leg.ok, true, "a container with no core-export policy is not broken");
  assert.equal(leg.comparable, false);
  assert.equal(leg.source, "live-engine-checkout");
});

// GWT2, in the form the leg has to survive: the recorded isolation debt is 484 symbols
// wide, so a leg that reported every unconsumed export would be red forever and would be
// deleted within a week. It reports the ones the file does not already record, which is
// the only version of this check anybody would keep. Red leg: compare counts instead of
// names, and swapping a retired symbol for a new one stays green.
test("unusedExports names the export that is not already recorded as isolated", async (context) => {
  const fixture = await completeInstallFixture(context);
  const leg = (result) => result.checks.find((entry) => entry.name === "unusedExports");
  const run = (unusedExports) => inspectInstallFixture(fixture, { unusedExports });

  const recorded = leg(await run({
    exported: ["alpha", "beta", "gamma"],
    unconsumed: ["beta", "gamma"],
    allowed: ["beta", "gamma"],
    consumerFiles: 23,
  }));
  assert.equal(recorded.ok, true, "debt already written down is not a new finding");
  assert.equal(recorded.unconsumedCount, 2);
  assert.equal(recorded.allowedCount, 2);

  const added = leg(await run({
    exported: ["alpha", "beta", "gamma"],
    unconsumed: ["beta", "gamma"],
    allowed: ["beta"],
    consumerFiles: 23,
  }));
  assert.equal(added.ok, false);
  assert.equal(added.reasonCode, "PLATFORM_CORE_EXPORT_UNCONSUMED");
  assert.deepEqual(added.unconsumedWithoutAllowance, ["gamma"], "only the unrecorded symbol is named");
  // The measured counts stay at the top level whichever half tripped, so a reader is
  // never left reconstructing them from the lists.
  assert.equal(added.exportedCount, 3);
  assert.equal(added.unconsumedCount, 2);
});

test("T7: the core barrel keeps only consumed skill entrypoints and removes stale allowances", async () => {
  const skillExports = new Set([
    "InstallSkillCopiesInput", "InstalledSkillCopy", "LEGACY_SKILL_MARKER_FILES", "LEGACY_SKILL_ROOTS",
    "LegacySkillCleanupItem", "LegacySkillCleanupKind", "LegacySkillCleanupPlan", "LegacySkillCleanupResult",
    "RenderSkillMarkdownInput", "SKILL_COPIES_FILES", "SKILL_COPIES_REASON_CODES", "SKILL_COPIES_SCHEMA_VERSION",
    "SKILL_COPY_ROOTS", "SKILL_DESCRIPTION", "SKILL_MARKDOWN_BYTE_LIMIT", "SKILL_NAVIGATION", "SKILL_RENDER_REASON_CODES",
    "SkillCopiesError", "SkillCopiesInstallReport", "SkillCopiesReasonCode", "SkillCopiesRecord", "SkillCopiesVerification",
    "SkillCopyAction", "SkillCopyHost", "SkillCopyRecord", "SkillCopyRoot", "SkillCopyVerification", "SkillCopyVerificationCode",
    "SkillNavigationEntry", "SkillRenderError", "SkillRenderReasonCode", "applyLegacySkillCleanup", "installSkillCopies",
    "isLegacySkillMarker", "legacySkillCleanupPlan", "renderSkillMarkdown", "skillCopiesRecordPath", "skillCopyPath",
    "skillNamedVerbs", "verifySkillCopies",
  ]);
  const barrel = await readFile(join(import.meta.dirname, "../packages/core/src/index.ts"), "utf8");
  assert.deepEqual(coreExportedSymbols(barrel).filter((symbol) => skillExports.has(symbol)), ["SKILL_COPIES_FILES", "renderSkillMarkdown"]);

  const policy = JSON.parse(await readFile(join(import.meta.dirname, "../scripts/policy/core-export-consumers.json"), "utf8"));
  assert.deepEqual(policy.allowedUnconsumed.filter((symbol) => ["computeInstallTreeDigest", "managedSectionRecordsFor", "writeVariablesSections", "DIRECTORY", "Library", "LEGACY_CONTROL_DIRECTORY"].includes(symbol)), []);
});

// The half that keeps the file a register rather than an amnesty. An entry may only
// leave allowedUnconsumed, and it must leave the moment the debt is paid -- otherwise
// the list outlives the symbols it names and the next reader inherits 484 lines of
// which some unknown number are fiction. Red leg: report only unconsumed exports, and
// the file rots exactly the way scripts/policy/coverage-baseline.json was found to.
test("a recorded allowance that gained a consumer or lost its symbol is its own red", async (context) => {
  const fixture = await completeInstallFixture(context);
  const leg = (result) => result.checks.find((entry) => entry.name === "unusedExports");
  const run = (unusedExports) => inspectInstallFixture(fixture, { unusedExports });

  // Paid by a consumer arriving, and paid by a retirement: two different acts, reported
  // apart, because only one of them shrank the public surface.
  const stale = leg(await run({
    exported: ["alpha", "beta"],
    unconsumed: ["beta"],
    allowed: ["alpha", "beta", "zeta"],
    consumerFiles: 23,
  }));
  assert.equal(stale.ok, false);
  assert.equal(stale.reasonCode, "PLATFORM_CORE_EXPORT_ALLOWANCE_STALE");
  assert.deepEqual(stale.consumedAllowances, ["alpha"], "still exported, now called");
  assert.deepEqual(stale.absentAllowances, ["zeta"], "no longer exported at all");
  assert.deepEqual(stale.unconsumedWithoutAllowance, undefined);

  // An unrecorded export and a stale allowance at once reports the unrecorded one,
  // because that is the finding a reader has to act on before the file can be trimmed.
  const both = leg(await run({
    exported: ["alpha", "beta"],
    unconsumed: ["alpha", "beta"],
    allowed: ["alpha", "zeta"],
    consumerFiles: 23,
  }));
  assert.equal(both.reasonCode, "PLATFORM_CORE_EXPORT_UNCONSUMED");
  assert.deepEqual(both.unconsumedWithoutAllowance, ["beta"]);
  assert.deepEqual(both.absentAllowances, ["zeta"], "the stale entry is still reported beside it");
});

// TCRN-CROSS-SUB-414 (R16; judgment-r15 §2.7 V+1): every case above feeds the leg synthetic values,
// which is how 2c17ec8e left two barrel symbols without a consumer and the suite stayed green until
// the batch gate ran the doctor. This one measures this checkout -- the barrel, the policy file and
// the consumer roots it names -- with the leg's own measurement, no synthetic values and no second
// implementation. The checkout is the one this file sits in, reached through the engine directory
// of a complete container, so run in a worktree it measures that worktree. Red leg: export a symbol
// no recorded root names, without recording it, and this names it.
test("SUB-414: unusedExports measured on this checkout names no unrecorded export and no stale allowance", async (context) => {
  const fixture = await completeInstallFixture(context);
  await mkdir(join(fixture.root, LOCAL_DIRECTORY_NAMES.classificationFolder), { recursive: true });
  await symlink(join(import.meta.dirname, ".."), join(fixture.root, LOCAL_DIRECTORY_NAMES.engine));
  const leg = (await inspectInstallFixture(fixture)).checks.find((entry) => entry.name === "unusedExports");
  assert.equal(leg.source, "live-engine-checkout");
  assert.notEqual(leg.comparable, false, "the checkout's policy and barrel were read");
  const found = { reasonCode: leg.reasonCode, unconsumedWithoutAllowance: leg.unconsumedWithoutAllowance, absentAllowances: leg.absentAllowances, consumedAllowances: leg.consumedAllowances };
  assert.equal(leg.ok, true, `unusedExports on this checkout: ${JSON.stringify(found)}`);
  assert.equal(leg.unconsumedCount, leg.allowedCount, "every unconsumed export is recorded, and nothing else is");
  assert.ok(leg.consumerFiles > 0, "the recorded consumer roots were walked");
});

// The barrel re-exports its type surface in its own `export type { ... }` blocks. A
// reader that walked only the value blocks would call every one of those types
// unexported and never report a single one of them -- the same shape that makes a
// missed type re-export a TS2305 when a symbol is retired. Red leg: drop `type` from
// the block pattern and the measured export count silently loses the types.
test("coreExportedSymbols reads declarations, value blocks and type blocks alike", () => {
  const symbols = coreExportedSymbols([
    'export const FRAMEWORK_VERSION = "1.0.1" as const;',
    "export type WorkflowMode = \"development\" | \"release\";",
    "export interface ExplicitRoot { readonly path: string; }",
    "export function admitDevelopment(): void {}",
    'export { assertDistinctRoots, RootIdentityError } from "./root-identity.js";',
    'export type { CanonicalRoot } from "./root-identity.js";',
    "export {",
    "  readVocabulary,",
    "  VOCABULARY_VERSION,",
    '} from "./vocabulary.js";',
    "export type {",
    "  SegmentIndexDocument,",
    '} from "./segmented-backend.js";',
    'export { internalName as publicName } from "./rename.js";',
    "const notExported = 1;",
  ].join("\n"));
  assert.deepEqual(symbols, [
    "CanonicalRoot",
    "ExplicitRoot",
    "FRAMEWORK_VERSION",
    "RootIdentityError",
    "SegmentIndexDocument",
    "VOCABULARY_VERSION",
    "WorkflowMode",
    "admitDevelopment",
    "assertDistinctRoots",
    "publicName",
    "readVocabulary",
  ]);
  assert.equal(symbols.includes("notExported"), false);
  assert.equal(symbols.includes("internalName"), false, "a rename exposes the public name, not the local one");
});

nodeTest.describe("platform-doctor behavior matrix", { concurrency: platformDoctorConcurrency }, () => {
  for (const [name, options, body] of queuedTests) nodeTest(name, { ...options, concurrency: platformDoctorConcurrency }, body);
});
