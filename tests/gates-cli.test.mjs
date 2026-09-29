// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-485 AC1 to AC4 through the CLI (MIN-227 D4; TCRN-CROSS-SUB-345). Gates are
// declared with gates-config-set, listed and removed; gates-plan names the gates a change needs, or
// every enabled gate for a release; gates-run runs them all and answers every red; and a Story is
// refused at done without required coverage or a same-tree, same-declaration, subject-bound run.
// TCRN-CROSS-STORY-513 R1, AC1 (MIN-238 D2; TCRN-CROSS-SUB-422): gates-config-set and
// gates-config-remove run for Atelier only; a model's run is refused with MODEL_WRITE_REFUSED and
// appends nothing, while the reads, the plan and the run answer it.
// Every project, library and device directory here is a temporary one.

import "./helpers/device-home.mjs";
import { ATELIER_SURFACE, standInForAtelier, withSurface } from "./helpers/workspace-fixture.mjs";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
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

async function cli(args) {
  let output = "";
  await runCli(args, { write(value) { output += value; } });
  return JSON.parse(output);
}

async function refusal(args) {
  return runCli(args, { write() {} }).then(() => null, (error) => error);
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
  assert.equal(notRun.details.remedy, "gates-run");
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
  assert.deepEqual(passed.doneGates, { checked: true, reason: "green", runId: green.run.runId, treeDigest: green.run.treeDigest });

  const greenBirth = await cli(["gates-run", "--workspace", library, "--at", at(), "--project", project, "--base", baseCommit, "--work-id", birthId]);
  assert.deepEqual(greenBirth.requiredReds, [], gateDiagnostic(greenBirth.run, greenBirth.recordPath));
  const born = await cli(createBorn);
  assert.equal(born.record.status, "done");
  assert.deepEqual(born.doneGates, { checked: true, reason: "green", runId: greenBirth.run.runId, treeDigest: greenBirth.run.treeDigest });
});

test("D8 (CLI): path covers still select gates, but only exact work-id covers establish Story coverage", async (context) => {
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
  await put(project, "src/unrelated.ts");
  const bin = fileURLToPath(new URL("../scripts/einzbern.mjs", import.meta.url));
  const invalidWorkId = spawnSync(process.execPath, [bin, "gates-plan", "--workspace", library, "--project", project, "--base", baseCommit, "--work-id", "work:not-an-id"], { encoding: "utf8", env: process.env });
  assert.equal(invalidWorkId.status, 1);
  const invalidEnvelope = JSON.parse(invalidWorkId.stderr.trim().split("\n").at(-1));
  assert.deepEqual([invalidEnvelope.reasonCode, invalidEnvelope.workId], ["GATES_WORK_ID_INVALID", "work:not-an-id"]);
  const uncoveredPlan = await cli(["gates-plan", "--workspace", library, "--project", project, "--base", baseCommit, "--work-id", storyId]);
  assert.deepEqual(uncoveredPlan.gates.map((gate) => [gate.name, gate.matched, gate.matchedWorkIds]), [["path", ["src/unrelated.ts"], []]],
    "a matching path selects its gate without creating a Story-id match");
  const uncoveredRun = await cli(["gates-run", "--workspace", library, "--at", at(), "--project", project, "--base", baseCommit, "--work-id", storyId]);
  assert.deepEqual(uncoveredRun.run.workIds, [storyId]);
  assert.deepEqual(uncoveredRun.run.gates.map((gate) => [gate.name, gate.matchedWorkIds]), [["path", []]]);
  const refused = await refusal(["work-transition", "--workspace", library, "--at", at(), "--id", storyId, "--status", "done", "--project", project]);
  assert.equal(refused?.reasonCode, "WORK_DONE_GATES_NOT_COVERED");
  assert.equal((await cli(["work-show", "--workspace", library, "--id", storyId])).record.status, "active");

  await declare(library, "subject", null, ["--covers", storyId]);
  const coveredPlan = await cli(["gates-plan", "--workspace", library, "--project", project, "--base", baseCommit, "--work-id", storyId]);
  assert.deepEqual(coveredPlan.gates.map((gate) => [gate.name, gate.reason, gate.matchedWorkIds]), [
    ["path", "changed", []],
    ["subject", "work-id", [storyId]],
  ]);
  const coveredRun = await cli(["gates-run", "--workspace", library, "--at", at(), "--project", project, "--base", baseCommit, "--work-id", storyId]);
  assert.deepEqual(coveredRun.run.gates.map((gate) => [gate.name, gate.matchedWorkIds]), [["path", []], ["subject", [storyId]]]);
  const passed = await cli(["work-transition", "--workspace", library, "--at", at(), "--id", storyId, "--status", "done", "--project", project]);
  assert.equal(passed.doneGates.runId, coveredRun.run.runId);
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
    [() => ["gates-config-set", "--workspace", library, "--at", at(), "--name", "self-check", "--command", JSON.stringify(green), "--covers", storyId], "self-check"],
    // the red gate made optional,
    [() => ["gates-config-set", "--workspace", library, "--at", at(), "--name", "unit", "--required", "false"], "unit"],
    // or the red gate taken away.
    [() => ["gates-config-remove", "--workspace", library, "--at", at(), "--name", "unit"], "unit"],
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
