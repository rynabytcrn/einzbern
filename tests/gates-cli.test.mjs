// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-485 AC1 to AC4 through the CLI (MIN-227 D4; TCRN-CROSS-SUB-345). Gates are
// declared with gates-config-set, listed and removed; gates-plan names the gates a change needs, or
// every enabled gate for a release; gates-run runs them all and answers every red; and a Story is
// refused at done without required coverage or a same-tree, same-declaration, subject-bound run.
// TCRN-CROSS-STORY-513 R1, AC1 (MIN-238 D2; TCRN-CROSS-SUB-422): gates-config-set and
// gates-config-remove run for Atelier only; a model's run is refused with MODEL_WRITE_REFUSED and
// appends nothing, while the reads, the plan and the run answer it.
// TCRN-CROSS-STORY-519 (TCRN-CROSS-SUB-430, SUB-431): on a coordination library, a Story that the
// library's own gates cover by exact work id is planned and run in the project root registered for
// the library, in its project's scope, and that run takes it to done; uncovered work keeps its results.
// Every project, library and device directory here is a temporary one.

import "./helpers/device-home.mjs";
import { ATELIER_SURFACE, standInForAtelier, withSurface } from "./helpers/workspace-fixture.mjs";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { COMMAND_CATALOG, MODEL_WRITE_REMEDY, SURFACE_ENVIRONMENT_VARIABLE, runCli } from "../dist/build/packages/cli/src/index.js";
import { materializeWorkspace } from "../dist/build/packages/core/src/index.js";
import { deriveStableId } from "../dist/build/packages/protocol/src/index.js";

// TCRN-CROSS-STORY-513 R1: these tests declare and remove gates through the CLI, as Atelier does; a
// model's shell is withSurface(undefined, ...).
standInForAtelier();

let second = 0;
const at = () => {
  second += 1;
  return new Date(Date.UTC(2026, 8, 27, 10, 0, second)).toISOString().replace(".000Z", "Z");
};
const node = process.execPath;
const workId = (key) => deriveStableId("work", key);
function gateDiagnostic(run, recordPath) {
  const outputDirectory = dirname(recordPath);
  const gates = run.gates.map(({ name, ok, exitCode, signal, timedOut, outputFile }) => {
    if (exitCode !== null || signal !== null || timedOut) return { name, ok, exitCode, signal, timedOut };
    let processError = "unknown";
    try {
      const output = readFileSync(join(outputDirectory, outputFile), "utf8");
      processError = /einzbern: the gate could not run: ([A-Z][A-Z0-9_]*)(?:\r?\n|$)/u.exec(output)?.[1] ?? processError;
    } catch {
      // The gate result remains useful when its output is unavailable; never echo raw output.
    }
    return { name, ok, exitCode, signal, timedOut, processError };
  });
  return `gate outcomes: ${JSON.stringify(gates)}`;
}

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function git(root, args) {
  return execFileSync("git", ["-C", root, "-c", "user.name=gates-cli-test", "-c", "user.email=gates-cli-test-at-example.invalid", "-c", "commit.gpgsign=false", ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function put(root, path, text = `${path}\n`) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), text);
}

const fixtureProjectIds = new Map();

async function cli(args) {
  // Configuration targets come from this fixture's explicit project-create receipt.
  const libraryFlag = args[0] === "library-register" ? "--library" : "--workspace";
  const library = args[args.indexOf(libraryFlag) + 1];
  const projectId = fixtureProjectIds.get(library);
  const targetVerbs = ["gates-config-set", "gates-config-list", "gates-config-remove", "gates-plan", "gates-run", "library-register"];
  if (projectId && targetVerbs.includes(args[0]) && !args.includes("--project-id")) args = [...args, "--project-id", projectId];
  let output = "";
  await runCli(args, { write(value) { output += value; } });
  const result = JSON.parse(output);
  if (args[0] === "project-create") fixtureProjectIds.set(library, result.record.id);
  return result;
}

async function refusal(args) {
  return runCli(args, { write() {} }).then(() => null, (error) => error);
}

// TCRN-CROSS-STORY-519: the CLI as a caller types it, without the --project-id cli() adds. The
// coordination fixtures go through it alone, so their registry entry is the one a migration writes.
async function raw(args) {
  let output = "";
  await runCli(args, { write(value) { output += value; } });
  return JSON.parse(output);
}

/** A Git project with one commit, a library beside it and a device directory, all temporary. */
async function setup(context) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-gates-cli-")));
  const previousHome = process.env.HOME;
  const previousDeviceHome = process.env.EINZBERN_HOME;
  const home = join(base, "home");
  await mkdir(home);
  process.env.HOME = home;
  process.env.EINZBERN_HOME = join(base, "desk");
  context.after(async () => {
    restoreEnv("HOME", previousHome);
    restoreEnv("EINZBERN_HOME", previousDeviceHome);
    await rm(base, { recursive: true, force: true });
  });
  const project = join(base, "project");
  await mkdir(project);
  git(project, ["init", "-q"]);
  for (const path of ["src/a.ts", "README.md", "portal/index.html", "packages/core.ts"]) await put(project, path);
  git(project, ["add", "-A"]);
  git(project, ["commit", "-q", "-m", "initial"]);
  const library = join(base, ".ether");
  await cli(["init", "--workspace", library, "--at", at()]);
  return { base, project, library, baseCommit: git(project, ["rev-parse", "HEAD"]).trim() };
}

function declare(library, name, command, extra = []) {
  return cli(["gates-config-set", "--workspace", library, "--at", at(), "--name", name, ...(command === null ? [] : ["--command", JSON.stringify(command)]), ...extra]);
}

async function declareSuite(library) {
  await declare(library, "portal", ["node", "--version"], ["--covers", "portal/**"]);
  await declare(library, "engine", ["node", "--version"], ["--covers", "packages/**,scripts/**"]);
  await declare(library, "links", ["node", "--version"], ["--covers", "**/*.md", "--required", "false"]);
  await declare(library, "release-pack", ["node", "--version"], ["--release-only", "true"]);
  await declare(library, "off", ["node", "--version"], ["--enabled", "false"]);
}

const names = (plan) => plan.gates.map((gate) => gate.name);

test("485-R1 (CLI): gates are declared, listed, redeclared in part and removed, and a malformed one is refused", async (context) => {
  const { library } = await setup(context);
  const declared = await declare(library, "unit", [node, "-e", "process.exit(0)"], ["--covers", "src/**"]);
  assert.equal(declared.reasonCode, "WORKSPACE_COMMAND_COMPLETED");
  assert.deepEqual(declared.gate, { name: "unit", command: [node, "-e", "process.exit(0)"], root: ".", covers: ["src/**"], required: true, enabled: true, releaseOnly: false });
  await declare(library, "docs", ["node", "--version"], ["--covers", "**/*.md", "--required", "false"]);

  const listed = await cli(["gates-config-list", "--workspace", library]);
  assert.equal(listed.reasonCode, "WORKSPACE_LIST_READY");
  assert.equal(listed.kind, "gate");
  assert.deepEqual(listed.records.map((gate) => [gate.name, gate.required]), [["docs", false], ["unit", true]], "sorted by name");

  // Declaring it again changes what the flags say and keeps the rest.
  const disabled = await declare(library, "unit", null, ["--enabled", "false"]);
  assert.deepEqual(disabled.gate, { ...declared.gate, enabled: false });

  const removed = await cli(["gates-config-remove", "--workspace", library, "--at", at(), "--name", "docs"]);
  assert.equal(removed.removed, "docs");
  assert.deepEqual((await cli(["gates-config-list", "--workspace", library])).records.map((gate) => gate.name), ["unit"]);
  assert.equal((await refusal(["gates-config-remove", "--workspace", library, "--at", at(), "--name", "docs"]))?.reasonCode, "CONFIG_RECORD_NOT_FOUND");

  // A new gate needs its command, as a JSON array of non-empty strings; its root stays in the project.
  assert.equal((await refusal(["gates-config-set", "--workspace", library, "--at", at(), "--name", "fresh"]))?.reasonCode, "CLI_ARGUMENT_MISSING");
  assert.equal((await refusal(["gates-config-set", "--workspace", library, "--at", at(), "--name", "fresh", "--command", "node --version"]))?.reasonCode, "CLI_ARGUMENT_MALFORMED");
  const empty = await refusal(["gates-config-set", "--workspace", library, "--at", at(), "--name", "fresh", "--command", "[]"]);
  assert.deepEqual([empty?.reasonCode, empty?.details.field], ["GATES_CONFIG_INVALID", "command"]);
  const outside = await refusal(["gates-config-set", "--workspace", library, "--at", at(), "--name", "fresh", "--command", "[\"node\"]", "--root", "../elsewhere"]);
  assert.deepEqual([outside?.reasonCode, outside?.details.field], ["GATES_CONFIG_INVALID", "root"]);
});

test("485-AC1 (CLI): only a file under portal changed, so gates-plan names only the gate covering portal", async (context) => {
  const { project, library, baseCommit } = await setup(context);
  await declareSuite(library);
  await put(project, "portal/index.html", "<p>changed</p>\n");
  const plan = await cli(["gates-plan", "--workspace", library, "--project", project, "--base", baseCommit]);
  assert.equal(plan.reasonCode, "GATES_PLAN_READY");
  assert.deepEqual(names(plan), ["portal"]);
  assert.deepEqual(plan.gates[0], { name: "portal", root: ".", command: ["node", "--version"], required: true, releaseOnly: false, reason: "changed", matched: ["portal/index.html"], matchedWorkIds: [] });
  assert.deepEqual(plan.changed, [{ root: ".", files: ["portal/index.html"] }]);
  assert.equal(plan.release, false);
  // A committed change is planned against the base it forked from.
  git(project, ["commit", "-q", "-am", "portal"]);
  assert.equal((await refusal(["gates-plan", "--workspace", library, "--project", project]))?.reasonCode, "GATES_BASE_REQUIRED");
  assert.deepEqual(names(await cli(["gates-plan", "--workspace", library, "--project", project, "--base", baseCommit])), ["portal"], "an explicit base includes committed changes");
});

test("485-AC2 (CLI): a release plan lists every enabled gate, release-only included, and the project comes from the registry", async (context) => {
  const { project, library } = await setup(context);
  await declareSuite(library);
  // Without --project the library needs a project this device registered for it.
  const unknown = await refusal(["gates-plan", "--workspace", library, "--release", "true"]);
  assert.equal(unknown?.reasonCode, "GATES_PROJECT_UNKNOWN");
  assert.match(unknown.details.remedy, /--project/u);
  await cli(["library-register", "--project", project, "--library", library, "--at", at()]);
  const plan = await cli(["gates-plan", "--workspace", library, "--release", "true"]);
  assert.equal(plan.projectRoot, await realpath(project));
  assert.deepEqual(names(plan), ["engine", "links", "portal", "release-pack"], "every enabled gate, sorted; the disabled one is not listed");
  assert.equal(plan.changed, null);
  assert.ok(plan.gates.every((gate) => gate.reason === "release" && gate.matched.length === 0));
});

test("485-AC3 (CLI): two gates red at once give two reds, and a red gate does not stop the next one", async (context) => {
  const { project, library, baseCommit } = await setup(context);
  await declare(library, "fail-a", [node, "-e", "process.stdout.write('a'); process.exit(3)"]);
  await declare(library, "fail-b", [node, "-e", "process.stderr.write('b'); process.exit(4)"]);
  await declare(library, "pass", [node, "-e", "process.exit(0)"], ["--required", "false"]);
  await put(project, "src/a.ts", "export const a = 2;\n");
  const ran = await cli(["gates-run", "--workspace", library, "--at", at(), "--project", project, "--base", baseCommit]);
  assert.equal(ran.reasonCode, "GATES_RUN_COMPLETED");
  assert.equal(ran.ok, false, gateDiagnostic(ran.run, ran.recordPath));
  assert.deepEqual(ran.reds, ["fail-a", "fail-b"], gateDiagnostic(ran.run, ran.recordPath));
  assert.deepEqual(ran.requiredReds, ["fail-a", "fail-b"], gateDiagnostic(ran.run, ran.recordPath));
  assert.deepEqual(ran.run.gates.map((gate) => [gate.name, gate.exitCode, gate.ok]), [["fail-a", 3, false], ["fail-b", 4, false], ["pass", 0, true]], `every gate ran; ${gateDiagnostic(ran.run, ran.recordPath)}`);
  assert.ok(ran.recordPath.endsWith(`${ran.run.runId}.json`));
});

test("485-AC4 (CLI): required exact Story covers guard transition, birth-done, and batch done writes", async (context) => {
  const { project, library, baseCommit } = await setup(context);
  const projectId = (await cli(["project-create", "--workspace", library, "--at", at(), "--external-key", "GC-PROJECT", "--name", "Gates CLI"])).record.id;
  await cli(["work-create", "--workspace", library, "--at", at(), "--project-id", projectId, "--external-key", "GC-INIT", "--kind", "Initiative", "--title", "Gated work"]);
  await cli(["work-create", "--workspace", library, "--at", at(), "--project-id", projectId, "--external-key", "GC-EPIC", "--kind", "Epic", "--status", "active", "--parent-id", workId("GC-INIT"), "--title", "Gated epic"]);
  const story = (key) => cli([
    "work-create", "--workspace", library, "--at", at(), "--project-id", projectId, "--external-key", key, "--kind", "Story", "--status", "active",
    "--parent-id", workId("GC-EPIC"), "--title", `Gated story ${key}`, "--goal", "Pass the gates", "--acceptance", "GIVEN the gates WHEN green THEN done",
  ]);
  const storyId = (await story("GC-STORY-1")).record.id;
  const story2Id = workId("GC-STORY-2");
  const birthId = workId("GC-STORY-BIRTH");
  await declare(library, "unit", [node, "-e", "process.exit(require('node:fs').existsSync('src/ok') ? 0 : 1)"], ["--covers", `src/**,${storyId},${story2Id},${birthId}`]);
  await declare(library, "lint", [node, "-e", "process.exit(2)"], ["--covers", "src/**", "--required", "false"]);
  await cli(["library-register", "--project", project, "--library", library, "--at", at()]);
  await put(project, "src/a.ts", "export const a = 2;\n");
  const done = (id = storyId) => ["work-transition", "--workspace", library, "--at", at(), "--id", id, "--status", "done", "--project", project];

  const notRun = await refusal(done());
  assert.equal(notRun?.reasonCode, "WORK_DONE_GATES_NOT_RUN");
  assert.match(notRun.details.remedy, /gates-run --work-id <Story id> with --base <commit> or --release/u);
  assert.deepEqual(notRun.details.stories, [storyId]);

  const red = await cli(["gates-run", "--workspace", library, "--at", at(), "--project", project, "--base", baseCommit, "--work-id", storyId]);
  assert.deepEqual([red.reds, red.requiredReds], [["lint", "unit"], ["unit"]], gateDiagnostic(red.run, red.recordPath));
  const refused = await refusal(done());
  assert.equal(refused?.reasonCode, "WORK_DONE_GATES_RED");
  assert.deepEqual(refused.details.reds, ["unit"], "only the required red gate holds the Story back");
  assert.equal(refused.details.runId, red.run.runId);
  const shown = await cli(["work-show", "--workspace", library, "--id", storyId]);
  assert.equal(shown.record.status, "active", "nothing was written");

  // The bin prints the red gates on stderr.
  const bin = fileURLToPath(new URL("../scripts/einzbern.mjs", import.meta.url));
  const printed = spawnSync(process.execPath, [bin, ...done()], { encoding: "utf8", env: process.env });
  assert.equal(printed.status, 1);
  const stderr = JSON.parse(printed.stderr.trim().split("\n").at(-1));
  assert.deepEqual([stderr.reasonCode, stderr.reds, stderr.stories, stderr.runId], ["WORK_DONE_GATES_RED", ["unit"], [storyId], red.run.runId]);

  // A record that is not a Story is not held to the gates.
  const epic = await cli(["work-transition", "--workspace", library, "--at", at(), "--id", workId("GC-EPIC"), "--status", "done", "--project", project]);
  assert.deepEqual(epic.doneGates, { checked: false, reason: "no-story", runId: null, treeDigest: null });

  // An existing Story that a batch takes to done is checked with the exact subject-bound run.
  const batch = join(project, "..", "batch.json");
  await writeFile(batch, `${JSON.stringify({
    schemaVersion: "tcrn.work-batch.v1",
    members: [
      { verb: "work-create", projectId, externalKey: "GC-STORY-2", kind: "Story", status: "active", parentId: workId("GC-EPIC"), title: "Batch story", goal: "Pass the gates", acceptance: "GIVEN the gates WHEN green THEN done" },
      { verb: "work-transition", externalKey: "GC-STORY-2", status: "done" },
    ],
  })}\n`);
  const red2 = await cli(["gates-run", "--workspace", library, "--at", at(), "--project", project, "--base", baseCommit, "--work-id", workId("GC-STORY-2")]);
  assert.deepEqual(red2.requiredReds, ["unit"], gateDiagnostic(red2.run, red2.recordPath));
  const batchRefused = await refusal(["work-batch", "--workspace", library, "--at", at(), "--from-file", batch, "--project", project]);
  assert.equal(batchRefused?.reasonCode, "WORK_DONE_GATES_RED");
  assert.deepEqual(batchRefused.details.stories, [story2Id]);
  assert.equal((await refusal(["work-show", "--workspace", library, "--id", story2Id]))?.reasonCode, "WORKSPACE_INPUT_INVALID", "the batch wrote nothing");

  // A batch combining a normal transition with a directly born done Story refuses before either member writes.
  const mixed = join(project, "..", "mixed-batch.json");
  await writeFile(mixed, `${JSON.stringify({
    schemaVersion: "tcrn.work-batch.v1",
    members: [
      { verb: "work-transition", id: storyId, status: "done" },
      { verb: "work-create", projectId, externalKey: "GC-STORY-BIRTH", kind: "Story", status: "done", parentId: workId("GC-EPIC"), title: "Born done Story", goal: "Pass the gates", acceptance: "GIVEN the gates WHEN green THEN done" },
    ],
  })}\n`);
  const mixedRun = await cli(["gates-run", "--workspace", library, "--at", at(), "--project", project, "--base", baseCommit, "--work-id", `${storyId},${birthId}`]);
  assert.deepEqual(mixedRun.requiredReds, ["unit"], gateDiagnostic(mixedRun.run, mixedRun.recordPath));
  const mixedRefused = await refusal(["work-batch", "--workspace", library, "--at", at(), "--from-file", mixed, "--project", project]);
  assert.equal(mixedRefused?.reasonCode, "WORK_DONE_GATES_RED");
  assert.deepEqual(mixedRefused.details.stories, [storyId, birthId]);
  assert.equal((await cli(["work-show", "--workspace", library, "--id", storyId])).record.status, "active");
  assert.equal((await refusal(["work-show", "--workspace", library, "--id", birthId]))?.reasonCode, "WORKSPACE_INPUT_INVALID", "neither mixed-batch member was written");

  // A standalone birth-done Story also needs its own bound green run.
  const createBorn = ["work-create", "--workspace", library, "--at", at(), "--project-id", projectId, "--external-key", "GC-STORY-BIRTH", "--kind", "Story", "--status", "done", "--parent-id", workId("GC-EPIC"), "--title", "Born done Story", "--goal", "Pass the gates", "--acceptance", "GIVEN the gates WHEN green THEN done"];
  const birthRed = await cli(["gates-run", "--workspace", library, "--at", at(), "--project", project, "--base", baseCommit, "--work-id", birthId]);
  assert.deepEqual(birthRed.requiredReds, ["unit"], gateDiagnostic(birthRed.run, birthRed.recordPath));
  const birthRefused = await refusal(createBorn);
  assert.equal(birthRefused?.reasonCode, "WORK_DONE_GATES_RED");
  assert.equal((await refusal(["work-show", "--workspace", library, "--id", birthId]))?.reasonCode, "WORKSPACE_INPUT_INVALID", "birth-done refusal wrote no Story");

  // Green on the tree as it is now: each exact Story binding passes transition, batch, and birth-done.
  await put(project, "src/ok", "");
  const green2 = await cli(["gates-run", "--workspace", library, "--at", at(), "--project", project, "--base", baseCommit, "--work-id", story2Id]);
  assert.deepEqual([green2.reds, green2.requiredReds], [["lint"], []], gateDiagnostic(green2.run, green2.recordPath));
  const batched = await cli(["work-batch", "--workspace", library, "--at", at(), "--from-file", batch, "--project", project]);
  assert.equal(batched.doneGates.reason, "green");
  assert.equal((await cli(["work-show", "--workspace", library, "--id", story2Id])).record.status, "done");

  const green = await cli(["gates-run", "--workspace", library, "--at", at(), "--project", project, "--base", baseCommit, "--work-id", storyId]);
  assert.deepEqual([green.reds, green.requiredReds], [["lint"], []], gateDiagnostic(green.run, green.recordPath));
  const passed = await cli(done());
  assert.equal(passed.record.status, "done");
  assert.deepEqual(passed.doneGates, { checked: true, reason: "green", runId: green.run.runId, treeDigest: green.run.treeDigest, projectId, targets: [{ checked: true, reason: "green", runId: green.run.runId, treeDigest: green.run.treeDigest, projectId }] });

  const greenBirth = await cli(["gates-run", "--workspace", library, "--at", at(), "--project", project, "--base", baseCommit, "--work-id", birthId]);
  assert.deepEqual(greenBirth.requiredReds, [], gateDiagnostic(greenBirth.run, greenBirth.recordPath));
  const born = await cli(createBorn);
  assert.equal(born.record.status, "done");
  assert.deepEqual(born.doneGates, { checked: true, reason: "green", runId: greenBirth.run.runId, treeDigest: greenBirth.run.treeDigest, projectId, targets: [{ checked: true, reason: "green", runId: greenBirth.run.runId, treeDigest: greenBirth.run.treeDigest, projectId }] });
});

test("D8, 525 (CLI): a plan for a Story holds every required gate with the Story bound, and a path cover alone binds no Story", async (context) => {
  for (const verb of ["gates-plan", "gates-run"]) {
    assert.deepEqual(COMMAND_CATALOG.find((entry) => entry.name === verb)?.flags.find((flag) => flag.name === "work-id"),
      { name: "work-id", required: false, valueKind: "list" }, `${verb} catalogs its exact Story binding`);
  }
  const { project, library, baseCommit } = await setup(context);
  const projectId = (await cli(["project-create", "--workspace", library, "--at", at(), "--external-key", "GC-ID-PROJECT", "--name", "Gates ID CLI"])).record.id;
  await cli(["work-create", "--workspace", library, "--at", at(), "--project-id", projectId, "--external-key", "GC-ID-INIT", "--kind", "Initiative", "--title", "Gated work"]);
  await cli(["work-create", "--workspace", library, "--at", at(), "--project-id", projectId, "--external-key", "GC-ID-EPIC", "--kind", "Epic", "--status", "active", "--parent-id", workId("GC-ID-INIT"), "--title", "Gated epic"]);
  const storyId = workId("GC-ID-STORY");
  await cli(["work-create", "--workspace", library, "--at", at(), "--project-id", projectId, "--external-key", "GC-ID-STORY", "--kind", "Story", "--status", "active", "--parent-id", workId("GC-ID-EPIC"), "--title", "Subject Story", "--goal", "Pass the gates", "--acceptance", "GIVEN the gates WHEN green THEN done"]);
  await cli(["library-register", "--project", project, "--library", library, "--at", at()]);
  const other = workId("GC-ID-OTHER");
  await declare(library, "path", [node, "-e", "process.exit(0)"], ["--covers", "src/**"]);
  await declare(library, "subject", [node, "-e", "process.exit(0)"], ["--covers", other]);
  await declare(library, "optional", [node, "-e", "process.exit(0)"], ["--covers", "src/**", "--required", "false"]);
  await put(project, "src/unrelated.ts");
  const bin = fileURLToPath(new URL("../scripts/einzbern.mjs", import.meta.url));
  const invalidWorkId = spawnSync(process.execPath, [bin, "gates-plan", "--workspace", library, "--project", project, "--base", baseCommit, "--work-id", "work:not-an-id"], { encoding: "utf8", env: process.env });
  assert.equal(invalidWorkId.status, 1);
  const invalidEnvelope = JSON.parse(invalidWorkId.stderr.trim().split("\n").at(-1));
  assert.deepEqual([invalidEnvelope.reasonCode, invalidEnvelope.workId], ["GATES_WORK_ID_INVALID", "work:not-an-id"]);
  const uncoveredPlan = await cli(["gates-plan", "--workspace", library, "--project", project, "--base", baseCommit, "--work-id", storyId]);
  assert.deepEqual(uncoveredPlan.gates.map((gate) => [gate.name, gate.reason, gate.matched, gate.matchedWorkIds]), [
    ["optional", "changed", ["src/unrelated.ts"], []],
    ["path", "changed", ["src/unrelated.ts"], [storyId]],
    ["subject", "required", [], [storyId]],
  ], "every required gate is planned for the Story; a matching path selects an optional gate without binding the Story");
  const uncoveredRun = await cli(["gates-run", "--workspace", library, "--at", at(), "--project", project, "--base", baseCommit, "--work-id", storyId]);
  assert.deepEqual(uncoveredRun.run.workIds, [storyId]);
  assert.deepEqual(uncoveredRun.run.gates.map((gate) => [gate.name, gate.matchedWorkIds]), [["optional", []], ["path", [storyId]], ["subject", [storyId]]]);
  // TCRN-CROSS-STORY-525 (TCRN-CROSS-SUB-448): that run binds the Story to every gate that applies to it, so
  // its covers need not name it; a changed declaration below makes it another set of gates.
  await declare(library, "subject", null, ["--covers", storyId]);
  const coveredPlan = await cli(["gates-plan", "--workspace", library, "--project", project, "--base", baseCommit, "--work-id", storyId]);
  assert.deepEqual(coveredPlan.gates.map((gate) => [gate.name, gate.reason, gate.matchedWorkIds]), [
    ["optional", "changed", []],
    ["path", "changed", [storyId]],
    ["subject", "work-id", [storyId]],
  ]);
  const coveredRun = await cli(["gates-run", "--workspace", library, "--at", at(), "--project", project, "--base", baseCommit, "--work-id", storyId]);
  assert.deepEqual(coveredRun.run.gates.map((gate) => [gate.name, gate.matchedWorkIds]), [["optional", []], ["path", [storyId]], ["subject", [storyId]]]);
  const passed = await cli(["work-transition", "--workspace", library, "--at", at(), "--id", storyId, "--status", "done", "--project", project]);
  assert.equal(passed.doneGates.runId, coveredRun.run.runId);
});

// TCRN-CROSS-STORY-525 GWT2, GWT3 (MIN-256; TCRN-CROSS-SUB-447): a cover naming an Epic reaches each
// Story under it, and a gate a Story's gates field names is planned for it with nothing changed.
test("525-GWT2, GWT3 (CLI): covers work:<Epic id> binds the Story under it in the run; a gate the Story's gates field names is selected by gates-plan --base --work-id", async (context) => {
  const { project, library, baseCommit } = await setup(context);
  const projectId = (await cli(["project-create", "--workspace", library, "--at", at(), "--external-key", "GC-525-PROJECT", "--name", "Gates 525"])).record.id;
  await cli(["work-create", "--workspace", library, "--at", at(), "--project-id", projectId, "--external-key", "GC-525-INIT", "--kind", "Initiative", "--title", "Gated work"]);
  const epicId = (await cli(["work-create", "--workspace", library, "--at", at(), "--project-id", projectId, "--external-key", "GC-525-EPIC", "--kind", "Epic", "--status", "active", "--parent-id", workId("GC-525-INIT"), "--title", "Gated epic"])).record.id;
  const story = async (key, extra = []) => (await cli([
    "work-create", "--workspace", library, "--at", at(), "--project-id", projectId, "--external-key", key, "--kind", "Story", "--status", "active",
    "--parent-id", epicId, "--title", key, "--goal", "Pass the gates", "--acceptance", "GIVEN the gates WHEN green THEN done", ...extra,
  ])).record.id;
  const storyId = await story("GC-525-STORY");
  const namedId = await story("GC-525-NAMED", ["--gates", "e2e,not-declared"]);
  await cli(["library-register", "--project", project, "--library", library, "--at", at()]);
  await declare(library, "epic-suite", [node, "-e", "process.exit(0)"], ["--covers", epicId, "--required", "false"]);
  await declare(library, "e2e", [node, "-e", "process.exit(0)"], ["--covers", "docs/**", "--required", "false"]);
  await declare(library, "unit", [node, "-e", "process.exit(0)"], ["--covers", "src/**"]);
  await declare(library, "pack", [node, "-e", "process.exit(0)"], ["--release-only", "true"]);

  // GWT2: the Epic's cover reaches its Story, with no file changed.
  const ran = await cli(["gates-run", "--workspace", library, "--at", at(), "--project", project, "--base", baseCommit, "--work-id", storyId]);
  assert.deepEqual(ran.run.gates.map((gate) => [gate.name, gate.matchedWorkIds]), [["epic-suite", [storyId]], ["unit", [storyId]]],
    `the run binds the Story to the Epic's gate and to every required one that is not release-only; ${gateDiagnostic(ran.run, ran.recordPath)}`);
  assert.equal(ran.ok, true);

  // GWT3: the gates field names e2e, an optional gate whose covers match nothing changed.
  const planned = await cli(["gates-plan", "--workspace", library, "--project", project, "--base", baseCommit, "--work-id", namedId]);
  assert.deepEqual(planned.gates.map((gate) => [gate.name, gate.reason, gate.matchedWorkIds]), [
    ["e2e", "work-field", [namedId]],
    ["epic-suite", "work-id", [namedId]],
    ["unit", "required", [namedId]],
  ]);
  assert.deepEqual(planned.unknownGates, ["not-declared"], "a name the project declares no gate by is listed");
  const unbound = await cli(["gates-plan", "--workspace", library, "--project", project, "--base", baseCommit]);
  assert.deepEqual([unbound.gates, Object.hasOwn(unbound, "unknownGates")], [[], false], "a plan made for no Story is unchanged");

  // The Epic itself can carry the name, and it reaches the Story.
  await cli(["work-annotate", "--workspace", library, "--at", at(), "--id", epicId, "--gates", "e2e"]);
  const inherited = await cli(["gates-plan", "--workspace", library, "--project", project, "--base", baseCommit, "--work-id", storyId]);
  assert.deepEqual(inherited.gates.map((gate) => [gate.name, gate.reason]), [["e2e", "work-field"], ["epic-suite", "work-id"], ["unit", "required"]]);
});

// TCRN-CROSS-STORY-525 GWT1 (MIN-256; TCRN-CROSS-SUB-448; Q8): the covers need not list the Story. A library
// with no enabled gate, or none that applies to the Story, holds it back from nothing, and needs no root.
test("525-GWT1 (CLI): one required gate covering **, and a Story the covers do not list goes to done after a green gates-run --work-id; no run is NOT_RUN and red is RED", async (context) => {
  const { project, library, baseCommit } = await setup(context);
  const projectId = (await cli(["project-create", "--workspace", library, "--at", at(), "--external-key", "GC-GWT1-PROJECT", "--name", "Gates GWT1"])).record.id;
  await cli(["work-create", "--workspace", library, "--at", at(), "--project-id", projectId, "--external-key", "GC-GWT1-INIT", "--kind", "Initiative", "--title", "Gated work"]);
  await cli(["work-create", "--workspace", library, "--at", at(), "--project-id", projectId, "--external-key", "GC-GWT1-EPIC", "--kind", "Epic", "--status", "active", "--parent-id", workId("GC-GWT1-INIT"), "--title", "Gated epic"]);
  const story = async (key) => (await cli([
    "work-create", "--workspace", library, "--at", at(), "--project-id", projectId, "--external-key", key, "--kind", "Story", "--status", "active",
    "--parent-id", workId("GC-GWT1-EPIC"), "--title", key, "--goal", "Pass the gates", "--acceptance", "GIVEN the gates WHEN green THEN done",
  ])).record.id;
  const done = (id) => ["work-transition", "--workspace", library, "--at", at(), "--id", id, "--status", "done", "--project", project];

  // No enabled gate: nothing holds the Story back, and no project root is needed (none is registered yet).
  const free = await cli(done(await story("GC-GWT1-FREE")));
  assert.deepEqual([free.record.status, free.doneGates.reason, free.doneGates.checked], ["done", "no-gates", false]);
  await declare(library, "optional", [node, "-e", "process.exit(0)"], ["--covers", "src/**", "--required", "false"]);
  const unbound = await cli(["work-transition", "--workspace", library, "--at", at(), "--id", await story("GC-GWT1-UNBOUND"), "--status", "done"]);
  assert.deepEqual([unbound.record.status, unbound.doneGates.reason], ["done", "no-applicable-gates"], "an optional path gate applies to no Story");

  const storyId = await story("GC-GWT1-STORY");
  await declare(library, "all", [node, "-e", "process.exit(require('node:fs').existsSync('src/ok') ? 0 : 1)"], ["--covers", "**"]);
  await cli(["library-register", "--project", project, "--library", library, "--at", at()]);
  const notRun = await refusal(done(storyId));
  assert.deepEqual([notRun?.reasonCode, notRun?.details.stories], ["WORK_DONE_GATES_NOT_RUN", [storyId]]);
  assert.match(notRun.details.remedy, /gates-run --work-id <Story id> with --base <commit> or --release/u);

  const red = await cli(["gates-run", "--workspace", library, "--at", at(), "--project", project, "--base", baseCommit, "--work-id", storyId]);
  assert.deepEqual([red.reds, red.requiredReds], [["all"], ["all"]], gateDiagnostic(red.run, red.recordPath));
  const refused = await refusal(done(storyId));
  assert.deepEqual([refused?.reasonCode, refused?.details.reds, refused?.details.runId], ["WORK_DONE_GATES_RED", ["all"], red.run.runId]);
  assert.equal((await cli(["work-show", "--workspace", library, "--id", storyId])).record.status, "active", "nothing was written");

  await put(project, "src/ok", "");
  const green = await cli(["gates-run", "--workspace", library, "--at", at(), "--project", project, "--base", baseCommit, "--work-id", storyId]);
  assert.deepEqual([green.ok, green.run.gates.map((gate) => [gate.name, gate.matchedWorkIds])], [true, [["all", [storyId]], ["optional", []]]], gateDiagnostic(green.run, green.recordPath));
  const passed = await cli(done(storyId));
  assert.equal(passed.record.status, "done");
  assert.deepEqual(passed.doneGates, { checked: true, reason: "green", runId: green.run.runId, treeDigest: green.run.treeDigest, projectId, targets: [{ checked: true, reason: "green", runId: green.run.runId, treeDigest: green.run.treeDigest, projectId }] });
});

// TCRN-CROSS-STORY-508 R7 (MIN-236 D7; TCRN-CROSS-SUB-408): gates-config-set --order places a gate in
// the plan; the order is not part of what a run proves (STORY-485 D8 unchanged).
test("508-R7 (CLI): gates-config-set --order orders the plan and the run; only the order changed, the last run still takes the Story to done; a changed command, covers or required does not", async (context) => {
  assert.deepEqual(COMMAND_CATALOG.find((entry) => entry.name === "gates-config-set").flags.find((flag) => flag.name === "order"), { name: "order", required: false, valueKind: "integer" });
  const { project, library } = await setup(context);
  const projectId = (await cli(["project-create", "--workspace", library, "--at", at(), "--external-key", "GC-ORDER-PROJECT", "--name", "Gates order"])).record.id;
  await cli(["work-create", "--workspace", library, "--at", at(), "--project-id", projectId, "--external-key", "GC-ORDER-INIT", "--kind", "Initiative", "--title", "Ordered gates"]);
  await cli(["work-create", "--workspace", library, "--at", at(), "--project-id", projectId, "--external-key", "GC-ORDER-EPIC", "--kind", "Epic", "--status", "active", "--parent-id", workId("GC-ORDER-INIT"), "--title", "Ordered epic"]);
  const story = async (key) => (await cli([
    "work-create", "--workspace", library, "--at", at(), "--project-id", projectId, "--external-key", key, "--kind", "Story", "--status", "active",
    "--parent-id", workId("GC-ORDER-EPIC"), "--title", `Ordered story ${key}`, "--goal", "Pass the gates", "--acceptance", "GIVEN the gates WHEN green THEN done",
  ])).record.id;
  const first = await story("GC-ORDER-STORY-1");
  const second = await story("GC-ORDER-STORY-2");
  await cli(["library-register", "--project", project, "--library", library, "--at", at()]);
  const covers = `src/**,${first},${second}`;
  await declare(library, "alpha", [node, "-e", "process.exit(0)"], ["--covers", covers]);
  const zulu = await declare(library, "zulu", [node, "-e", "process.exit(0)"], ["--covers", covers, "--order", "1"]);
  assert.equal(zulu.gate.order, 1);
  assert.deepEqual((await cli(["gates-config-list", "--workspace", library])).records.map((gate) => [gate.name, gate.order ?? null]), [["alpha", null], ["zulu", 1]]);
  assert.deepEqual(names(await cli(["gates-plan", "--workspace", library, "--release", "true"])), ["zulu", "alpha"], "the gate with an order first");
  // Redeclared in part, a gate keeps its order.
  assert.equal((await declare(library, "zulu", null, ["--required", "true"])).gate.order, 1);
  const malformed = await refusal(["gates-config-set", "--workspace", library, "--at", at(), "--name", "alpha", "--order", "0"]);
  assert.deepEqual([malformed?.reasonCode, malformed?.message], ["CLI_ARGUMENT_MALFORMED", "order"]);

  const run = await cli(["gates-run", "--workspace", library, "--at", at(), "--release", "true", "--work-id", first]);
  assert.deepEqual(run.run.gates.map((gate) => gate.name), ["zulu", "alpha"], `the run follows the plan; ${gateDiagnostic(run.run, run.recordPath)}`);
  assert.equal(run.ok, true, gateDiagnostic(run.run, run.recordPath));

  // Only the orders change: the same run still counts.
  await declare(library, "alpha", null, ["--order", "1"]);
  await declare(library, "zulu", null, ["--order", "2"]);
  assert.deepEqual(names(await cli(["gates-plan", "--workspace", library, "--release", "true"])), ["alpha", "zulu"]);
  const done = await cli(["work-transition", "--workspace", library, "--at", at(), "--id", first, "--status", "done", "--project", project]);
  assert.deepEqual([done.record.status, done.doneGates.runId], ["done", run.run.runId]);

  // A changed command, covers or required is another declaration: the run before it does not count.
  for (const [label, flags] of [
    ["command", ["--command", JSON.stringify([node, "-e", "process.exit(0) // changed"])]],
    ["covers", ["--covers", `${first},${second}`]],
    ["required", ["--required", "false"]],
  ]) {
    const green = await cli(["gates-run", "--workspace", library, "--at", at(), "--release", "true", "--work-id", second]);
    assert.equal(green.ok, true, `${label}: ${gateDiagnostic(green.run, green.recordPath)}`);
    await declare(library, "alpha", null, flags);
    const refused = await refusal(["work-transition", "--workspace", library, "--at", at(), "--id", second, "--status", "done", "--project", project]);
    assert.equal(refused?.reasonCode, "WORK_DONE_GATES_NOT_RUN", label);
  }
  const last = await cli(["gates-run", "--workspace", library, "--at", at(), "--release", "true", "--work-id", second]);
  const passed = await cli(["work-transition", "--workspace", library, "--at", at(), "--id", second, "--status", "done", "--project", project]);
  assert.deepEqual([passed.record.status, passed.doneGates.runId], ["done", last.run.runId]);
});

// TCRN-CROSS-STORY-513 R1, AC1 (MIN-238 D2, MIN-235 D11; TCRN-CROSS-SUB-422): a model at work can
// neither declare a gate that its own Story is then held to, nor loosen or take away the gate that
// holds it. Its gates-config-set and gates-config-remove are refused with MODEL_WRITE_REFUSED and the
// remedy of changing it in Atelier before the library is read, and append nothing; the same runs for
// Atelier write. gates-config-list, gates-plan and gates-run answer a model, and the red gate still
// holds its Story back.
test("513-AC1 (CLI): a model's gates-config-set and gates-config-remove are refused with the remedy and append nothing; Atelier's run writes; list, plan and run are not refused", async (context) => {
  const { project, library } = await setup(context);
  const projectId = (await cli(["project-create", "--workspace", library, "--at", at(), "--external-key", "GC-GUARD-PROJECT", "--name", "Gates guard"])).record.id;
  await cli(["work-create", "--workspace", library, "--at", at(), "--project-id", projectId, "--external-key", "GC-GUARD-INIT", "--kind", "Initiative", "--title", "Guarded gates"]);
  await cli(["work-create", "--workspace", library, "--at", at(), "--project-id", projectId, "--external-key", "GC-GUARD-EPIC", "--kind", "Epic", "--status", "active", "--parent-id", workId("GC-GUARD-INIT"), "--title", "Guarded epic"]);
  const storyId = (await cli([
    "work-create", "--workspace", library, "--at", at(), "--project-id", projectId, "--external-key", "GC-GUARD-STORY", "--kind", "Story", "--status", "active",
    "--parent-id", workId("GC-GUARD-EPIC"), "--title", "Guarded story", "--goal", "Pass the gates", "--acceptance", "GIVEN the gates WHEN green THEN done",
  ])).record.id;
  await cli(["library-register", "--project", project, "--library", library, "--at", at()]);
  // Atelier holds the Story to a required gate that is red.
  await declare(library, "unit", [node, "-e", "process.exit(1)"], ["--covers", storyId]);
  const asModel = (operation) => withSurface(undefined, operation);
  const versionOf = async () => (await materializeWorkspace(library)).version;
  const listed = async () => (await asModel(() => cli(["gates-config-list", "--workspace", library]))).records;
  const before = { version: await versionOf(), gates: await listed() };

  const green = [node, "-e", "process.exit(0)"];
  const writes = [
    // a green gate of its own that covers its Story,
    [() => ["gates-config-set", "--workspace", library, "--project-id", projectId, "--at", at(), "--name", "self-check", "--command", JSON.stringify(green), "--covers", storyId], "self-check"],
    // the red gate made optional,
    [() => ["gates-config-set", "--workspace", library, "--project-id", projectId, "--at", at(), "--name", "unit", "--required", "false"], "unit"],
    // or the red gate taken away.
    [() => ["gates-config-remove", "--workspace", library, "--project-id", projectId, "--at", at(), "--name", "unit"], "unit"],
  ];
  // Only the exact surface name lets a write through.
  for (const surface of [undefined, "", "Atelier", "atelier ", "portal"]) {
    for (const [argv, gate] of writes) {
      const args = argv();
      const error = await withSurface(surface, () => refusal(args));
      assert.equal(error?.reasonCode, "MODEL_WRITE_REFUSED", `${args[0]} ${gate} with EINZBERN_SURFACE=${String(surface)}`);
      assert.deepEqual({ ...error.details }, { gate, remedy: MODEL_WRITE_REMEDY });
      assert.equal(error.message, `gate ${gate} is changed in Atelier; a model does not write it through the CLI`);
    }
  }
  // Through the shipped entry the refusal reaches stderr with its remedy.
  const bin = fileURLToPath(new URL("../scripts/einzbern.mjs", import.meta.url));
  const shipped = await asModel(async () => spawnSync(process.execPath, [bin, ...writes[0][0]()], { encoding: "utf8", env: process.env }));
  assert.deepEqual([shipped.status, shipped.stdout], [1, ""]);
  assert.deepEqual(JSON.parse(shipped.stderr.trim().split("\n").at(-1)), { ok: false, reasonCode: "MODEL_WRITE_REFUSED", remedy: MODEL_WRITE_REMEDY, error: "gate self-check is changed in Atelier; a model does not write it through the CLI" });
  assert.equal(await versionOf(), before.version, "no refused write appended an event");
  assert.deepEqual(await listed(), before.gates, "a model reads the gates, unchanged");

  // The plan and the run answer a model, and the red gate still holds its Story back.
  assert.deepEqual(names(await asModel(() => cli(["gates-plan", "--workspace", library, "--release", "true", "--work-id", storyId]))), ["unit"]);
  const red = await asModel(() => cli(["gates-run", "--workspace", library, "--at", at(), "--release", "true", "--work-id", storyId]));
  assert.deepEqual(red.requiredReds, ["unit"], gateDiagnostic(red.run, red.recordPath));
  const held = await asModel(() => refusal(["work-transition", "--workspace", library, "--at", at(), "--id", storyId, "--status", "done", "--project", project]));
  assert.equal(held?.reasonCode, "WORK_DONE_GATES_RED");

  // The same writes run for Atelier commit, in order: the first through the shipped entry with
  // EINZBERN_SURFACE=atelier, as Atelier runs it.
  const atelier = await asModel(async () => spawnSync(process.execPath, [bin, ...writes[0][0]()], { encoding: "utf8", env: { ...process.env, [SURFACE_ENVIRONMENT_VARIABLE]: ATELIER_SURFACE } }));
  assert.equal(atelier.status, 0, atelier.stderr);
  assert.deepEqual(JSON.parse(atelier.stdout).gate, { name: "self-check", command: green, root: ".", covers: [storyId], required: true, enabled: true, releaseOnly: false });
  assert.equal((await cli(writes[1][0]())).gate.required, false);
  assert.equal((await cli(writes[2][0]())).removed, "unit");
  assert.equal(await versionOf(), before.version + writes.length);
  assert.deepEqual((await listed()).map((gate) => gate.name), ["self-check"]);
});

/**
 * TCRN-CROSS-STORY-519: a coordination library as setup and migration leave it. Its chain identity
 * names it the coordination library, its Stories sit under its own project with their relation left
 * undecided, and this device registered the directory it serves (`project`) for it with no project,
 * as setup and migration register it (library-register without --project-id). `addProject` adds
 * another project with its own Initiative and Epic; `story` and `gate` take the project to use.
 */
async function coordination(context) {
  const fixture = await setup(context);
  const { project, library } = fixture;
  const libraryId = (await materializeWorkspace(library)).metadata.workspaceId;
  await raw(["chain-declare", "--workspace", library, "--at", at(), "--role", "coordination", "--coordination-library-id", libraryId]);
  const epics = new Map();
  const addProject = async (key, name) => {
    const id = (await raw(["project-create", "--workspace", library, "--at", at(), "--external-key", key, "--name", name])).record.id;
    await raw(["work-create", "--workspace", library, "--at", at(), "--project-id", id, "--external-key", `${key}-INIT`, "--kind", "Initiative", "--title", `${name} work`]);
    await raw(["work-create", "--workspace", library, "--at", at(), "--project-id", id, "--external-key", `${key}-EPIC`, "--kind", "Epic", "--status", "active", "--parent-id", workId(`${key}-INIT`), "--title", `${name} epic`]);
    epics.set(id, workId(`${key}-EPIC`));
    return id;
  };
  const projectId = await addProject("CO-PROJECT", "Cross project");
  await raw(["library-register", "--project", project, "--library", library, "--at", at()]);
  const story = async (key, extra = [], storyProjectId = projectId) => (await raw([
    "work-create", "--workspace", library, "--at", at(), "--project-id", storyProjectId, "--external-key", key, "--kind", "Story", "--status", "active",
    "--parent-id", epics.get(storyProjectId), "--title", `Coordinated story ${key}`, "--goal", "Pass the gates", "--acceptance", "GIVEN the gates WHEN green THEN done", ...extra,
  ])).record.id;
  const gate = (name, command, extra = [], gateProjectId = projectId) => raw(["gates-config-set", "--workspace", library, "--project-id", gateProjectId, "--at", at(), "--name", name, "--command", JSON.stringify(command), ...extra]);
  return { ...fixture, libraryId, projectId, addProject, story, gate };
}

/** A project library that the coordination library's work can select, registered with its project. */
async function selectableTarget(base, coordinationLibraryId) {
  const repo = join(base, "target");
  await mkdir(repo);
  git(repo, ["init", "-q"]);
  await put(repo, "README.md");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "initial"]);
  const library = join(base, "target.ether");
  await raw(["init", "--workspace", library, "--at", at()]);
  await raw(["chain-declare", "--workspace", library, "--at", at(), "--role", "project", "--coordination-library-id", coordinationLibraryId]);
  const libraryId = (await materializeWorkspace(library)).metadata.workspaceId;
  const projectId = (await raw(["project-create", "--workspace", library, "--at", at(), "--external-key", "CO-TARGET", "--name", "Target"])).record.id;
  await raw(["gates-config-set", "--workspace", library, "--project-id", projectId, "--at", at(), "--name", "target-unit", "--command", JSON.stringify([node, "-e", "process.exit(0)"])]);
  await raw(["library-register", "--project", repo, "--library", library, "--at", at(), "--project-id", projectId]);
  return { repo, library, reference: { libraryId, projectId } };
}

const gateRunFiles = (recordPath) => readdirSync(dirname(recordPath)).filter((name) => name.endsWith(".json")).sort();

// TCRN-CROSS-STORY-519 GWT1 (TCRN-CROSS-SUB-430; D-519-1, D-519-2): on a coordination library,
// gates-plan and gates-run with --work-id plan and run a Story that the library's own gates cover by
// exact work id, in the project root this device registered for the library and in the scope of the
// Story's project. The run records that project and exactly that Story, and its required gate the
// Story among its matched work ids. --project-id is the Story's project when left out; another one
// is refused before anything runs.
test("519-GWT1 (CLI): a Story a coordination library's own gates cover by exact work id is planned and run in the library's project root, in its project's scope", async (context) => {
  const { project, library, libraryId, projectId, story, gate } = await coordination(context);
  const storyId = await story("CO-STORY-1");
  await gate("unit", [node, "-e", "process.exit(require('node:fs').existsSync('src/ok') ? 0 : 1)"], ["--covers", `src/**,${storyId}`]);
  await gate("links", [node, "-e", "process.exit(0)"], ["--covers", "**/*.md", "--required", "false"]);
  await put(project, "src/ok", "");
  const args = ["--workspace", library, "--release", "true", "--work-id", storyId];

  // In 2.0.0 this plan answered PROJECT_SCOPE_UNDECIDED for the Story and no gate ran.
  const planned = await raw(["gates-plan", ...args]);
  assert.deepEqual([planned.reasonCode, planned.ok, planned.targets], ["GATES_PLAN_READY", true, []]);
  assert.equal(planned.library.length, 1);
  const [plan] = planned.library;
  assert.deepEqual([plan.projectId, plan.workIds, plan.projectRoot, plan.ok], [projectId, [storyId], project, true]);
  assert.deepEqual([plan.plan.projectRoot, plan.plan.release, plan.plan.workIds], [project, true, [storyId]]);
  assert.deepEqual(plan.plan.gates.map((entry) => [entry.name, entry.required, entry.matchedWorkIds]), [["links", false, []], ["unit", true, [storyId]]]);
  assert.deepEqual((await raw(["gates-plan", ...args, "--project-id", projectId])).library, planned.library, "--project-id naming the Story's own project is the same plan");

  const ran = await raw(["gates-run", ...args, "--at", at()]);
  assert.deepEqual([ran.reasonCode, ran.ok, ran.targets], ["GATES_RUN_COMPLETED", true, []]);
  assert.equal(ran.library.length, 1);
  const [result] = ran.library;
  assert.deepEqual([result.projectId, result.workIds, result.projectRoot, result.ok, result.reds, result.requiredReds], [projectId, [storyId], project, true, [], []], gateDiagnostic(result.run, result.recordPath));
  assert.deepEqual([result.run.libraryId, result.run.projectId, result.run.workIds, result.run.release], [libraryId, projectId, [storyId], true]);
  assert.deepEqual(result.run.gates.map((entry) => [entry.name, entry.required, entry.matchedWorkIds, entry.ok]), [["links", false, [], true], ["unit", true, [storyId], true]]);
  assert.deepEqual(JSON.parse(readFileSync(result.recordPath, "utf8")), result.run, "the run is recorded in this device's cache of the library");

  // A --project-id other than the Story's is refused before any gate runs.
  const otherProjectId = (await raw(["project-create", "--workspace", library, "--at", at(), "--external-key", "CO-OTHER", "--name", "Other"])).record.id;
  const runs = gateRunFiles(result.recordPath);
  for (const verb of [["gates-plan"], ["gates-run", "--at", at()]]) {
    const refused = await refusal([...verb, ...args, "--project-id", otherProjectId]);
    assert.equal(refused?.reasonCode, "GATES_PROJECT_MISMATCH", verb[0]);
    assert.deepEqual([refused.details.field, refused.details.workId], ["project-id", storyId]);
    assert.match(refused.details.remedy, /--project-id/u);
  }
  assert.deepEqual(gateRunFiles(result.recordPath), runs, "the refused run recorded nothing");
});

// TCRN-CROSS-STORY-519 GWT3 (TCRN-CROSS-SUB-430; D-519-1): work the coordination library does not
// cover keeps the results it had in 2.0.0: undecided, coordination-only, or one per selected target,
// and nothing under library. A covered Story needs no decided relation; a selected Story still runs
// per target, one the library also covers runs in both, and the coordination library is never a
// target.
test("519-GWT3 (CLI): uncovered work keeps its results; a selected Story still runs per target, and one the library also covers runs in both", async (context) => {
  const { base, project, library, libraryId, projectId, story, gate } = await coordination(context);
  const target = await selectableTarget(base, libraryId);
  const selected = ["--involved-projects", JSON.stringify({ state: "selected", targets: [target.reference] })];
  const coordinationOnly = ["--involved-projects", JSON.stringify({ state: "coordination-only", targets: [] })];
  const ids = {
    undecided: await story("CO-UNDECIDED"),
    coordinationOnly: await story("CO-ONLY", coordinationOnly),
    selected: await story("CO-SELECTED", selected),
    coveredUndecided: await story("CO-COVERED-UNDECIDED"),
    coveredOnly: await story("CO-COVERED-ONLY", coordinationOnly),
    coveredSelected: await story("CO-COVERED-SELECTED", selected),
  };
  // Optional, so it applies only to the Stories it names (TCRN-CROSS-STORY-525: a required gate applies to every Story).
  await gate("unit", [node, "-e", "process.exit(0)"], ["--covers", `${ids.coveredUndecided},${ids.coveredOnly},${ids.coveredSelected}`, "--required", "false"]);
  // A gate that is not enabled covers nothing.
  await gate("off", [node, "-e", "process.exit(0)"], ["--covers", ids.undecided, "--enabled", "false"]);
  const plan = (workIds) => raw(["gates-plan", "--workspace", library, "--release", "true", "--work-id", workIds.join(",")]);

  const uncovered = await plan([ids.undecided, ids.coordinationOnly]);
  assert.deepEqual(uncovered.targets, [
    { workId: ids.undecided, status: "undecided", ok: false, reasonCode: "PROJECT_SCOPE_UNDECIDED" },
    { workId: ids.coordinationOnly, status: "coordination-only", ok: true, reasonCode: "COORDINATION_ONLY" },
  ]);
  assert.equal(uncovered.ok, false);
  assert.equal(Object.hasOwn(uncovered, "library"), false, "nothing is listed under library when the library covers none of the work");

  const covered = await plan([ids.coveredUndecided, ids.coveredOnly]);
  assert.deepEqual([covered.ok, covered.targets], [true, []], "a covered Story gets no PROJECT_SCOPE_UNDECIDED or COORDINATION_ONLY result");
  assert.deepEqual(covered.library.map((entry) => [entry.projectId, entry.workIds, entry.projectRoot, entry.ok]), [[projectId, [ids.coveredUndecided, ids.coveredOnly], project, true]]);

  const ran = await raw(["gates-run", "--workspace", library, "--release", "true", "--at", at(), "--work-id", [ids.selected, ids.coveredOnly, ids.coveredSelected].join(",")]);
  assert.equal(ran.ok, true, JSON.stringify(ran.targets.map((entry) => [entry.workId, entry.reasonCode ?? null])));
  assert.deepEqual(ran.targets.map((entry) => [entry.workId, entry.reference.libraryId, entry.reference.projectId, entry.projectRoot, entry.ok]), [
    [ids.selected, target.reference.libraryId, target.reference.projectId, target.repo, true],
    [ids.coveredSelected, target.reference.libraryId, target.reference.projectId, target.repo, true],
  ], "each selected Story runs per target, and the coordination library is not one");
  assert.deepEqual(ran.targets.map((entry) => entry.run.gates.map((result) => result.name)), [["target-unit"], ["target-unit"]]);
  assert.deepEqual(ran.library.map((entry) => [entry.projectId, entry.workIds, entry.projectRoot, entry.ok]), [[projectId, [ids.coveredOnly, ids.coveredSelected], project, true]]);
  assert.deepEqual(ran.library[0].run.workIds, [ids.coveredOnly, ids.coveredSelected].sort());
  assert.deepEqual(ran.library[0].run.gates.map((result) => [result.name, result.matchedWorkIds]), [["unit", [ids.coveredOnly, ids.coveredSelected].sort()]]);

  // TCRN-CROSS-STORY-525 (TCRN-CROSS-SUB-447): an enabled required gate of the project's scope applies to
  // every Story of it, so the library takes on the undecided Story as well; a release-only one only for a release.
  await gate("suite", [node, "-e", "process.exit(0)"], ["--release-only", "true"]);
  const releaseOnly = await raw(["gates-plan", "--workspace", library, "--base", "HEAD", "--project", project, "--work-id", ids.undecided]);
  assert.equal(Object.hasOwn(releaseOnly, "library"), false, "a release-only required gate takes nothing on outside a release");
  const takenOn = await plan([ids.undecided]);
  assert.deepEqual([takenOn.targets, takenOn.library.map((entry) => [entry.workIds, entry.plan.gates.map((result) => [result.name, result.reason, result.matchedWorkIds])])], [
    [], [[[ids.undecided], [["suite", "release", [ids.undecided]], ["unit", "release", []]]]],
  ], "a release plan lists every enabled gate and binds the Story to those that apply to it");
});

// TCRN-CROSS-STORY-519 GWT2 (TCRN-CROSS-SUB-431; D-519-2, D-519-3): on a coordination library
// registered with no project, as migration leaves it, the done check finds the library's root for the
// Story's project, and a green run of the same tree and declarations bound to exactly that Story takes
// it to done through work-transition and work-batch, with the run in the receipt. No run, a red
// required gate and no required cover are refused with the codes of 2.0.0. Stories of two projects
// run once per project, each in its own scope.
test("519-GWT2 (CLI): a green run in the coordination library takes its Story to done through work-transition and work-batch; red and no run are refused", async (context) => {
  const { base, project, library, projectId, addProject, story, gate } = await coordination(context);
  const secondProjectId = await addProject("CO-SECOND", "Second project");
  const storyId = await story("CO-DONE-1");
  const optionalOnly = await story("CO-OPTIONAL-ONLY");
  const secondId = await story("CO-DONE-2", [], secondProjectId);
  const check = [node, "-e", "process.exit(require('node:fs').existsSync('src/ok') ? 0 : 1)"];
  await gate("unit", check, ["--covers", `src/**,${storyId}`]);
  await gate("lint", [node, "-e", "process.exit(0)"], ["--covers", optionalOnly, "--required", "false"]);
  await gate("unit", check, ["--covers", secondId], secondProjectId);
  const done = (id) => ["work-transition", "--workspace", library, "--at", at(), "--id", id, "--status", "done"];
  const runFor = (ids) => raw(["gates-run", "--workspace", library, "--at", at(), "--release", "true", "--work-id", ids.join(",")]);

  // No run yet: the root is found (2.0.0 refused GATES_PROJECT_UNKNOWN here) and the Story is not run.
  const notRun = await refusal(done(storyId));
  assert.equal(notRun?.reasonCode, "WORK_DONE_GATES_NOT_RUN");
  assert.deepEqual(notRun.details.stories, [storyId]);

  // A red required gate holds the Story back and names the run.
  const red = await runFor([storyId]);
  assert.deepEqual([red.ok, red.library[0].requiredReds], [false, ["unit"]], gateDiagnostic(red.library[0].run, red.library[0].recordPath));
  const refused = await refusal(done(storyId));
  assert.deepEqual([refused?.reasonCode, refused?.details.reds, refused?.details.runId], ["WORK_DONE_GATES_RED", ["unit"], red.library[0].run.runId]);

  // An optional gate's cover runs the Story here, and the required gate of its project applies to it as
  // well (TCRN-CROSS-STORY-525): red, it holds the Story back.
  const optional = await runFor([optionalOnly]);
  assert.deepEqual(optional.library.map((entry) => [entry.workIds, entry.run.gates.find((result) => result.name === "lint").matchedWorkIds, entry.run.gates.find((result) => result.name === "unit").matchedWorkIds]), [[[optionalOnly], [optionalOnly], [optionalOnly]]]);
  const uncovered = await refusal(done(optionalOnly));
  assert.deepEqual([uncovered?.reasonCode, uncovered?.details.stories, uncovered?.details.reds], ["WORK_DONE_GATES_RED", [optionalOnly], ["unit"]]);
  assert.equal((await raw(["work-show", "--workspace", library, "--id", storyId])).record.status, "active", "no refusal wrote anything");

  // Green on the tree as it is: one run per project, each in its own scope and the same root.
  await put(project, "src/ok", "");
  const green = await runFor([storyId, secondId]);
  assert.equal(green.ok, true, JSON.stringify(green.library.map((entry) => [entry.projectId, entry.reasonCode ?? entry.requiredReds])));
  assert.deepEqual(green.library.map((entry) => [entry.projectId, entry.workIds, entry.projectRoot, entry.run.projectId, entry.run.workIds]), [
    [projectId, [storyId], project, projectId, [storyId]],
    [secondProjectId, [secondId], project, secondProjectId, [secondId]],
  ]);
  const [first, second] = green.library.map((entry) => entry.run);
  assert.notEqual(first.declarationsDigest, second.declarationsDigest, "each project's run is made under its own declarations");

  const passed = await raw(done(storyId));
  assert.equal(passed.record.status, "done");
  assert.deepEqual(passed.doneGates, { checked: true, reason: "green", runId: first.runId, treeDigest: first.treeDigest, projectId, targets: [{ checked: true, reason: "green", runId: first.runId, treeDigest: first.treeDigest, projectId }] });

  const batch = join(base, "coordination-batch.json");
  await writeFile(batch, `${JSON.stringify({ schemaVersion: "tcrn.work-batch.v1", members: [{ verb: "work-transition", id: secondId, status: "done" }] })}\n`);
  const batched = await raw(["work-batch", "--workspace", library, "--at", at(), "--from-file", batch]);
  assert.deepEqual(batched.doneGates, { checked: true, reason: "green", runId: second.runId, treeDigest: second.treeDigest, projectId: secondProjectId, targets: [{ checked: true, reason: "green", runId: second.runId, treeDigest: second.treeDigest, projectId: secondProjectId }] });
  assert.equal((await raw(["work-show", "--workspace", library, "--id", secondId])).record.status, "done");
});

// TCRN-CROSS-STORY-519 GWT4 (TCRN-CROSS-SUB-431; D-519-3): a coordination library registered with no
// project has a gate root for each project it holds: the only such entry answers, or the one --project
// names, while no entry holds the project itself. A project chain, or a library with no chain identity,
// registered the same way still refuses a request for a project with GATES_PROJECT_UNKNOWN.
test("519-GWT4 (CLI): a coordination library registered with no project has a gate root for its projects; a project chain registered so still refuses GATES_PROJECT_UNKNOWN", async (context) => {
  const { base, project, library, libraryId, projectId, addProject, gate } = await coordination(context);
  const secondProjectId = await addProject("CO-SECOND", "Second project");
  await gate("unit", [node, "-e", "process.exit(0)"]);
  const plan = (extra) => raw(["gates-plan", "--workspace", library, "--release", "true", ...extra]);
  const unknown = async (extra) => {
    const refused = await refusal(["gates-plan", "--workspace", library, "--release", "true", ...extra]);
    assert.equal(refused?.reasonCode, "GATES_PROJECT_UNKNOWN", JSON.stringify(extra));
    return refused;
  };

  // 2.0.0 refused this plan with GATES_PROJECT_UNKNOWN.
  assert.deepEqual([(await plan(["--project-id", projectId])).projectRoot, (await plan(["--project-id", secondProjectId])).projectRoot], [project, project]);
  assert.equal((await plan(["--project", project, "--project-id", projectId])).projectRoot, project);
  assert.equal((await plan([])).projectRoot, project, "a plan for no project still takes the entry with no project");

  // Two entries with no project: neither answers alone; --project names one.
  const other = join(base, "other");
  await mkdir(other);
  await raw(["library-register", "--project", other, "--library", library, "--at", at()]);
  const ambiguous = await unknown(["--project-id", projectId]);
  assert.match(ambiguous.message, /2 directories/u);
  assert.match(ambiguous.details.remedy, /--project/u);
  assert.equal((await plan(["--project", other, "--project-id", projectId])).projectRoot, other);

  // Once an entry holds the project itself, it alone answers for that project.
  await raw(["library-register", "--project", other, "--library", library, "--at", at(), "--project-id", projectId]);
  assert.equal((await plan(["--project-id", projectId])).projectRoot, other);
  await unknown(["--project", project, "--project-id", projectId]);
  assert.equal((await plan(["--project-id", secondProjectId])).projectRoot, project, "a project no entry holds still takes the entry with no project");

  // A project chain, and a library with no chain identity, registered with no project: unchanged.
  for (const role of ["project", null]) {
    const name = role ?? "unclassified";
    const directory = join(base, `${name}-project`);
    await mkdir(directory);
    const projectLibrary = join(base, `${name}.ether`);
    await raw(["init", "--workspace", projectLibrary, "--at", at()]);
    if (role !== null) await raw(["chain-declare", "--workspace", projectLibrary, "--at", at(), "--role", role, "--coordination-library-id", libraryId]);
    const ownProjectId = (await raw(["project-create", "--workspace", projectLibrary, "--at", at(), "--external-key", `${name.toUpperCase()}-PROJECT`, "--name", name])).record.id;
    await raw(["gates-config-set", "--workspace", projectLibrary, "--project-id", ownProjectId, "--at", at(), "--name", "unit", "--command", JSON.stringify([node, "-e", "process.exit(0)"])]);
    await raw(["library-register", "--project", directory, "--library", projectLibrary, "--at", at()]);
    for (const extra of [["--project-id", ownProjectId], ["--project", directory, "--project-id", ownProjectId]]) {
      const refused = await refusal(["gates-plan", "--workspace", projectLibrary, "--release", "true", ...extra]);
      assert.equal(refused?.reasonCode, "GATES_PROJECT_UNKNOWN", `${name}: ${extra.join(" ")}`);
    }
  }
});
