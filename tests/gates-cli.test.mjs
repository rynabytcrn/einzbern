// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-485 AC1 to AC4 through the CLI (MIN-227 D4; TCRN-CROSS-SUB-345). Gates are
// declared with gates-config-set, listed and removed; gates-plan names the gates a change needs, or
// every enabled gate for a release; gates-run runs them all and answers every red; and a Story is
// refused at done while a required gate of its change is red on the tree as it is, or has not run
// on it. Every project, library and device directory here is a temporary one.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import { deriveStableId } from "../dist/build/packages/protocol/src/index.js";

let second = 0;
const at = () => {
  second += 1;
  return new Date(Date.UTC(2026, 8, 27, 10, 0, second)).toISOString().replace(".000Z", "Z");
};
const node = process.execPath;
const workId = (key) => deriveStableId("work", key);

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
  const previous = process.env.EINZBERN_HOME;
  process.env.EINZBERN_HOME = join(base, "desk");
  context.after(async () => {
    process.env.EINZBERN_HOME = previous;
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
  return { base, project, library };
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
  const { project, library } = await setup(context);
  await declareSuite(library);
  await put(project, "portal/index.html", "<p>changed</p>\n");
  const plan = await cli(["gates-plan", "--workspace", library, "--project", project]);
  assert.equal(plan.reasonCode, "GATES_PLAN_READY");
  assert.deepEqual(names(plan), ["portal"]);
  assert.deepEqual(plan.gates[0], { name: "portal", root: ".", command: ["node", "--version"], required: true, releaseOnly: false, reason: "changed", matched: ["portal/index.html"] });
  assert.deepEqual(plan.changed, [{ root: ".", files: ["portal/index.html"] }]);
  assert.equal(plan.release, false);
  // A committed change is planned against the base it forked from.
  git(project, ["commit", "-q", "-am", "portal"]);
  assert.deepEqual(names(await cli(["gates-plan", "--workspace", library, "--project", project])), [], "nothing changed against HEAD");
  assert.deepEqual(names(await cli(["gates-plan", "--workspace", library, "--project", project, "--base", "HEAD~1"])), ["portal"]);
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
  const { project, library } = await setup(context);
  await declare(library, "fail-a", [node, "-e", "process.stdout.write('a'); process.exit(3)"]);
  await declare(library, "fail-b", [node, "-e", "process.stderr.write('b'); process.exit(4)"]);
  await declare(library, "pass", [node, "-e", "process.exit(0)"], ["--required", "false"]);
  await put(project, "src/a.ts", "export const a = 2;\n");
  const ran = await cli(["gates-run", "--workspace", library, "--at", at(), "--project", project]);
  assert.equal(ran.reasonCode, "GATES_RUN_COMPLETED");
  assert.equal(ran.ok, false);
  assert.deepEqual(ran.reds, ["fail-a", "fail-b"]);
  assert.deepEqual(ran.requiredReds, ["fail-a", "fail-b"]);
  assert.deepEqual(ran.run.gates.map((gate) => [gate.name, gate.exitCode, gate.ok]), [["fail-a", 3, false], ["fail-b", 4, false], ["pass", 0, true]], "every gate ran");
  assert.ok(ran.recordPath.endsWith(`${ran.run.runId}.json`));
});

test("485-AC4 (CLI): a required gate red refuses the Story's done and names it; green, the Story is done", async (context) => {
  const { project, library } = await setup(context);
  const projectId = (await cli(["project-create", "--workspace", library, "--at", at(), "--external-key", "GC-PROJECT", "--name", "Gates CLI"])).record.id;
  await cli(["work-create", "--workspace", library, "--at", at(), "--project-id", projectId, "--external-key", "GC-INIT", "--kind", "Initiative", "--title", "Gated work"]);
  await cli(["work-create", "--workspace", library, "--at", at(), "--project-id", projectId, "--external-key", "GC-EPIC", "--kind", "Epic", "--status", "active", "--parent-id", workId("GC-INIT"), "--title", "Gated epic"]);
  const story = (key) => cli([
    "work-create", "--workspace", library, "--at", at(), "--project-id", projectId, "--external-key", key, "--kind", "Story", "--status", "active",
    "--parent-id", workId("GC-EPIC"), "--title", `Gated story ${key}`, "--goal", "Pass the gates", "--acceptance", "GIVEN the gates WHEN green THEN done",
  ]);
  const storyId = (await story("GC-STORY-1")).record.id;
  await declare(library, "unit", [node, "-e", "process.exit(require('node:fs').existsSync('src/ok') ? 0 : 1)"], ["--covers", "src/**"]);
  await declare(library, "lint", [node, "-e", "process.exit(2)"], ["--covers", "src/**", "--required", "false"]);
  await put(project, "src/a.ts", "export const a = 2;\n");
  const done = (id = storyId) => ["work-transition", "--workspace", library, "--at", at(), "--id", id, "--status", "done", "--project", project];

  const notRun = await refusal(done());
  assert.equal(notRun?.reasonCode, "WORK_DONE_GATES_NOT_RUN");
  assert.equal(notRun.details.remedy, "gates-run");
  assert.deepEqual(notRun.details.stories, [storyId]);

  const red = await cli(["gates-run", "--workspace", library, "--at", at(), "--project", project]);
  assert.deepEqual([red.reds, red.requiredReds], [["lint", "unit"], ["unit"]]);
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

  // A Story a batch creates and takes to done passes the same check, and a refusal writes no member.
  const batch = join(project, "..", "batch.json");
  await writeFile(batch, `${JSON.stringify({
    schemaVersion: "tcrn.work-batch.v1",
    members: [
      { verb: "work-create", projectId, externalKey: "GC-STORY-2", kind: "Story", status: "active", parentId: workId("GC-EPIC"), title: "Batch story", goal: "Pass the gates", acceptance: "GIVEN the gates WHEN green THEN done" },
      { verb: "work-transition", externalKey: "GC-STORY-2", status: "done" },
    ],
  })}\n`);
  const batchRefused = await refusal(["work-batch", "--workspace", library, "--at", at(), "--from-file", batch, "--project", project]);
  assert.equal(batchRefused?.reasonCode, "WORK_DONE_GATES_RED");
  assert.deepEqual(batchRefused.details.stories, [workId("GC-STORY-2")]);
  assert.equal((await refusal(["work-show", "--workspace", library, "--id", workId("GC-STORY-2")]))?.reasonCode, "WORKSPACE_INPUT_INVALID", "the batch wrote nothing");

  // Green on the tree as it is now: the Story is done, and the receipt says which run passed it.
  await put(project, "src/ok", "");
  const green = await cli(["gates-run", "--workspace", library, "--at", at(), "--project", project]);
  assert.deepEqual([green.reds, green.requiredReds], [["lint"], []]);
  const passed = await cli(done());
  assert.equal(passed.record.status, "done");
  assert.deepEqual(passed.doneGates, { checked: true, reason: "green", runId: green.run.runId, treeDigest: green.run.treeDigest });
  const batched = await cli(["work-batch", "--workspace", library, "--at", at(), "--from-file", batch, "--project", project]);
  assert.equal(batched.doneGates.reason, "green");
  assert.equal((await cli(["work-show", "--workspace", library, "--id", workId("GC-STORY-2")])).record.status, "done");
});
