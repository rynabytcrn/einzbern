// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-469 (the engine switch), STORY-468 R4, AC2, AC3 (through the CLI), STORY-466
// R3, AC4 (old layout read-only) and STORY-467 AC3 (a changed akasha segment): every verb goes
// through a library; an old-layout workspace answers reads and refuses writes.

// Every in-process command runs as an explicit device; between them the process keeps the
// test's own device directory, never the real one.
import "./helpers/device-home.mjs";
import { standInForAtelier } from "./helpers/workspace-fixture.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import test from "node:test";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import { deriveStableId } from "../dist/build/packages/protocol/src/index.js";
import { LEGACY_FIXTURE_EXPECTED, restoreLegacyFixture } from "./helpers/legacy-fixture.mjs";

// TCRN-CROSS-STORY-484 R4, TCRN-CROSS-STORY-513 R1: these tests write settings and gates through the
// CLI, as Atelier does.
standInForAtelier();

const repositoryRoot = resolve(import.meta.dirname, "..");
const cliPath = join(repositoryRoot, "scripts/einzbern.mjs");
const tripwirePath = join(repositoryRoot, "tests/helpers/fs-write-tripwire.mjs");
const expected = LEGACY_FIXTURE_EXPECTED;

// A Story whose decider is not the Owner, so it may be finished without minutes.
const STORY_SCOPE = [
  "【Goal】为谁改变什么=library switch fixture；目的锚=STORY-469；符合性判据=命令可复跑；判定人=验收子代理。",
  "【Requirements】现象与证据=fixture 命令；修复项=实现 fixture。",
  "【Acceptance Criteria】GIVEN fixture WHEN 执行 THEN 通过。",
  "【Business Background】证据=测试需要真实 Story。",
  "【Preconditions】无——原因：测试已建库。",
  "【Assumptions】无——原因：不改变协议。",
  "【Use Cases & Examples】无——原因：只覆盖引擎。",
  "【Feature Toggle & Setting】无——原因：无运行时开关。",
  "【Permissions】测试执行方。",
  "【Implementation Notes】决策点及裁定状态=fixture planned。",
].join("\n");

let second = 0;
const at = () => {
  second += 1;
  return new Date(Date.UTC(2026, 8, 26, 1, 0, second)).toISOString().replace(".000Z", "Z");
};

async function scratch(context) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-switch-")));
  const previous = process.env.EINZBERN_HOME;
  context.after(async () => {
    if (previous === undefined) delete process.env.EINZBERN_HOME;
    else process.env.EINZBERN_HOME = previous;
    await rm(base, { recursive: true, force: true });
  });
  return base;
}

/** Run one CLI command in-process as the device whose directory is `device`. */
const fixtureProjectIds = new Map();

async function as(device, args) {
  process.env.EINZBERN_HOME = device;
  // Configuration targets come from this fixture's explicit project-create receipt.
  const libraryFlag = args[0] === "library-register" ? "--library" : "--workspace";
  const library = args[args.indexOf(libraryFlag) + 1];
  const projectId = fixtureProjectIds.get(library);
  const targetVerbs = ["gates-config-set", "gates-config-list", "gates-config-remove", "gates-plan", "gates-run", "library-register"];
  if (projectId && targetVerbs.includes(args[0]) && !args.includes("--project-id")) args = [...args, "--project-id", projectId];
  let output = "";
  await runCli(args, { write: (value) => { output += value; } });
  const result = JSON.parse(output);
  if (args[0] === "project-create") fixtureProjectIds.set(library, result.record.id);
  return result;
}

async function refusal(device, args) {
  try {
    await as(device, args);
  } catch (error) {
    return error;
  }
  assert.fail(`${args[0]} was expected to refuse`);
}

async function declareStoryGate(device, library, storyId) {
  const projectId = (await as(device, ["work-show", "--workspace", library, "--id", storyId])).record.projectId;
  const command = [process.execPath, "-e", "process.exit(0)"];
  const declaration = await as(device, [
    "gates-config-set", "--workspace", library, "--project-id", projectId, "--at", at(), "--name", "fixture-story-coverage",
    "--command", JSON.stringify(command), "--root", ".", "--covers", storyId, "--required", "true",
  ]);
  assert.deepEqual(declaration.gate, {
    name: "fixture-story-coverage", command, root: ".", covers: [storyId], required: true, enabled: true, releaseOnly: false,
  });
}

async function runStoryGate(device, library, projectRoot, storyId) {
  const projectId = (await as(device, ["work-show", "--workspace", library, "--id", storyId])).record.projectId;
  await as(device, ["library-register", "--project", projectRoot, "--library", library, "--project-id", projectId, "--at", at()]);
  const gateRun = await as(device, [
    "gates-run", "--workspace", library, "--project-id", projectId, "--at", at(), "--project", projectRoot,
    "--release", "true", "--work-id", storyId,
  ]);
  assert.equal(gateRun.reasonCode, "GATES_RUN_COMPLETED");
  assert.equal(gateRun.ok, true);
  assert.deepEqual(gateRun.requiredReds, []);
  assert.deepEqual(gateRun.run.workIds, [storyId]);
  assert.deepEqual(gateRun.run.gates.map(({ name, required, matchedWorkIds, ok }) => [name, required, matchedWorkIds, ok]), [
    ["fixture-story-coverage", true, [storyId], true],
  ], "the required gate ran green with exact coverage for this Story");
  return gateRun;
}

/** A project, an Initiative, an Epic under it and a Story under that, all active but the Story. */
async function seed(device, library, key) {
  const project = await as(device, ["project-create", "--workspace", library, "--at", at(), "--external-key", `${key}-PROJECT`, "--name", key]);
  const create = async (kind, externalKey, parentId, extra = []) => (await as(device, ["work-create", "--workspace", library, "--at", at(), "--project-id", project.record.id,
    "--external-key", externalKey, "--kind", kind, "--title", `${kind} ${externalKey}`, ...(parentId === null ? [] : ["--parent-id", parentId]), ...extra])).record;
  const initiative = await create("Initiative", `${key}-INITIATIVE`, null, ["--status", "active"]);
  const epic = await create("Epic", `${key}-EPIC`, initiative.id, ["--status", "active"]);
  const story = await create("Story", `${key}-STORY-1`, epic.id, ["--status", "active", "--scope", STORY_SCOPE]);
  return { projectId: project.record.id, initiative, epic, story };
}

async function sync(desk, laptop, deskDevice, laptopDevice) {
  for (const [from, to, device] of [[desk, laptop, deskDevice], [laptop, desk, laptopDevice]]) {
    await rm(join(to, "akasha", device), { recursive: true, force: true });
    await cp(join(from, "akasha", device), join(to, "akasha", device), { recursive: true });
  }
}

const deviceIdOf = async (device) => JSON.parse(await readFile(join(device, "device.json"), "utf8")).deviceId;

test("469: init creates a library, and projects, work, transitions, lists and shows go through it", async (context) => {
  const base = await scratch(context);
  const device = join(base, "device");
  const project = join(base, "project");
  const library = join(project, ".ether");
  const created = await as(device, ["init", "--workspace", library, "--project-name", "Switch", "--at", at()]);
  assert.equal(created.reasonCode, "LIBRARY_CREATED");
  assert.match(created.libraryId, /^library:[a-f0-9]{24}$/u);
  assert.deepEqual(created.versionVector, {});
  const { story, epic } = await seed(device, library, "SWITCH");
  await declareStoryGate(device, library, story.id);
  await runStoryGate(device, library, project, story.id);
  const moved = await as(device, ["work-transition", "--workspace", library, "--at", at(), "--id", story.id, "--status", "done", "--summary", "finished", "--project", project]);
  assert.equal(moved.reasonCode, "WORKSPACE_COMMAND_COMPLETED");
  assert.deepEqual(moved.ids, [story.id], "a write receipt names what it wrote");
  const listed = await as(device, ["work-list", "--workspace", library, "--parent-id", epic.id]);
  assert.deepEqual(listed.records.map((record) => [record.externalKey, record.status]), [["SWITCH-STORY-1", "done"]]);
  const byId = await as(device, ["work-show", "--workspace", library, "--id", story.id]);
  const byKey = await as(device, ["work-show", "--workspace", library, "--external-key", "switch-story-1"]);
  assert.deepEqual(byKey.record, byId.record);
  assert.equal(byId.record.status, "done");
  const deviceId = await deviceIdOf(device);
  const status = await as(device, ["status", "--workspace", library]);
  assert.equal(status.layout, "library");
  assert.equal(status.version, 6);
  assert.deepEqual(status.versionVector, { [deviceId]: 6 });
  assert.deepEqual(status.streams.map((stream) => [stream.deviceId, stream.sequence]), [[deviceId, 6]]);
  assert.equal(status.rejectedEventCount, 0);
  // Nothing but the stream directory was added to the library; the lock and the cache of derived
  // state live on the device (TCRN-CROSS-STORY-469 R4).
  assert.deepEqual((await readdir(library)).sort(), [".gitignore", "README.md", "akasha", "artifacts", "config", "crest", "manifest.json"]);
  assert.deepEqual(await readdir(join(library, "akasha")), [deviceId]);
  assert.deepEqual((await readdir(device)).sort(), ["cache", "device.json", "locks"]);
  const validated = await as(device, ["chain-validate", "--workspace", library]);
  assert.deepEqual([validated.reasonCode, validated.layout, validated.headEventHash], ["CHAIN_VALIDATED", "library", status.headEventHash]);
  assert.equal((await as(device, ["validate", "--workspace", library])).headEventHash, status.headEventHash, "validate is chain-validate");
  await assert.rejects(as(device, ["init", "--workspace", library, "--at", at()]), (error) => error?.reasonCode === "LIBRARY_TARGET_NOT_EMPTY");
});

test("468-R4: two devices write one library, each to its own stream, and status reports the version vector", async (context) => {
  const base = await scratch(context);
  const desk = join(base, "desk");
  const laptop = join(base, "laptop");
  const library = join(base, ".ether");
  await as(desk, ["init", "--workspace", library, "--at", at()]);
  const { projectId } = await seed(desk, library, "SHARED");
  await as(laptop, ["work-create", "--workspace", library, "--at", at(), "--project-id", projectId, "--external-key", "SHARED-LAPTOP-1", "--kind", "Initiative", "--title", "From the laptop"]);
  const [deskId, laptopId] = [await deviceIdOf(desk), await deviceIdOf(laptop)];
  assert.notEqual(deskId, laptopId);
  const status = await as(desk, ["status", "--workspace", library]);
  assert.deepEqual(status.versionVector, { [deskId]: 4, [laptopId]: 1 });
  assert.equal(status.version, 5);
  assert.equal(status.work, 4);
  const onLaptop = await as(laptop, ["status", "--workspace", library]);
  assert.equal(onLaptop.headEventHash, status.headEventHash, "both devices read the same library state");
  assert.deepEqual((await readdir(join(library, "akasha"))).sort(), [deskId, laptopId].sort());
});

test("468-AC2, AC3 (CLI): a lost race is a rejected event on work-show, and a taken key answers with its alias", async (context) => {
  const base = await scratch(context);
  const desk = join(base, "desk-device");
  const laptop = join(base, "laptop-device");
  const deskLibrary = join(base, "desk", ".ether");
  await as(desk, ["init", "--workspace", deskLibrary, "--at", at()]);
  const { projectId, story, epic } = await seed(desk, deskLibrary, "RACE");
  const laptopLibrary = join(base, "laptop", ".ether");
  const deskProject = join(base, "desk");
  const laptopProject = join(base, "laptop");
  await declareStoryGate(desk, deskLibrary, story.id);
  await mkdir(laptopProject, { recursive: true });
  await cp(deskLibrary, laptopLibrary, { recursive: true });
  // Apart: the desk finishes the Story; the laptop writes once more first, then finishes it too.
  await runStoryGate(desk, deskLibrary, deskProject, story.id);
  await as(desk, ["work-transition", "--workspace", deskLibrary, "--at", at(), "--id", story.id, "--status", "done", "--summary", "done on the desk", "--project", deskProject]);
  await as(laptop, ["work-create", "--workspace", laptopLibrary, "--at", at(), "--project-id", projectId, "--parent-id", epic.id,
    "--external-key", "RACE-STORY-500", "--kind", "Story", "--title", "Laptop 500", "--scope", STORY_SCOPE]);
  await runStoryGate(laptop, laptopLibrary, laptopProject, story.id);
  const lost = await as(laptop, ["work-transition", "--workspace", laptopLibrary, "--at", at(), "--id", story.id, "--status", "done", "--summary", "done on the laptop", "--project", laptopProject]);
  await as(desk, ["work-create", "--workspace", deskLibrary, "--at", at(), "--project-id", projectId, "--parent-id", epic.id,
    "--external-key", "RACE-STORY-500", "--kind", "Story", "--title", "Desk 500", "--scope", STORY_SCOPE]);
  const [deskId, laptopId] = [await deviceIdOf(desk), await deviceIdOf(laptop)];
  await sync(deskLibrary, laptopLibrary, deskId, laptopId);
  for (const [device, library] of [[desk, deskLibrary], [laptop, laptopLibrary]]) {
    const shown = await as(device, ["work-show", "--workspace", library, "--id", story.id]);
    assert.equal(shown.record.status, "done");
    assert.equal(shown.record.summary, "done on the desk", "the earlier clock applies");
    assert.equal(shown.rejectedEvents.length, 1);
    assert.deepEqual([shown.rejectedEvents[0].deviceId, shown.rejectedEvents[0].operation, shown.rejectedEvents[0].recordId], [laptopId, "work.updated", story.id]);
    assert.equal(lost.headEventHash !== shown.headEventHash, true);
    // The laptop took RACE-STORY-500 first in merge order (its clock is lower); the desk's is renamed.
    const holder = await as(device, ["work-show", "--workspace", library, "--external-key", "RACE-STORY-500"]);
    assert.equal(holder.record.title, "Laptop 500");
    assert.deepEqual(holder.aliasedBy, [{ externalKey: "RACE-STORY-501", id: deriveStableId("work", "RACE-STORY-501"), deviceId: deskId }]);
    const renamed = await as(device, ["work-show", "--workspace", library, "--external-key", "RACE-STORY-501"]);
    assert.equal(renamed.record.title, "Desk 500");
    assert.deepEqual(renamed.aliases, [{ externalKey: "RACE-STORY-500", id: deriveStableId("work", "RACE-STORY-500"), deviceId: deskId }]);
    const status = await as(device, ["status", "--workspace", library]);
    assert.equal(status.rejectedEventCount, 1);
  }
});

/** Restore the frozen old-layout fixture into a fresh directory. */
async function restoreFixture(base) {
  return (await restoreLegacyFixture(base, "legacy")).root;
}

async function treeDigest(root) {
  const rows = [];
  const walk = async (directory) => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      const metadata = await stat(path);
      rows.push(`${relative(root, path)}|${metadata.size}|${metadata.mtimeMs}|${entry.isFile() ? createHash("sha256").update(await readFile(path)).digest("hex") : "directory"}`);
      if (entry.isDirectory()) await walk(path);
    }
  };
  await walk(root);
  return rows;
}

test("466-R3, AC4 (tooling): an old-layout workspace answers every read under the write tripwire and refuses every write", async (context) => {
  const base = await scratch(context);
  const root = await restoreFixture(base);
  const device = join(base, "device");
  const before = await treeDigest(root);
  const read = (args) => {
    const run = spawnSync(process.execPath, ["--import", tripwirePath, cliPath, ...args], {
      encoding: "utf8",
      env: { ...process.env, EINZBERN_HOME: device, EINZBERN_TRIPWIRE_ROOT: root },
    });
    assert.equal(run.status, 0, `${args[0]}: ${run.stderr}`);
    return JSON.parse(run.stdout);
  };
  const status = read(["status", "--workspace", root]);
  assert.deepEqual([status.layout, status.workspaceId, status.version, status.headEventHash], ["legacy", expected.workspaceId, expected.version, expected.headEventHash]);
  const shown = read(["work-show", "--workspace", root, "--id", expected.records.story.id]);
  assert.deepEqual([shown.record.externalKey, shown.record.id, shown.record.status], [expected.records.story.externalKey, expected.records.story.id, expected.records.story.status]);
  assert.equal(read(["work-show", "--workspace", root, "--external-key", expected.records.story.externalKey]).record.id, expected.records.story.id);
  assert.equal(read(["work-list", "--workspace", root]).total, expected.work);
  const events = read(["event-list", "--workspace", root, "--limit", "100"]);
  assert.equal(events.total, expected.events);
  assert.equal(events.records.at(-1).eventHash, expected.headEventHash);
  const validated = read(["chain-validate", "--workspace", root]);
  assert.deepEqual([validated.layout, validated.headEventHash], ["legacy", expected.headEventHash]);
  assert.deepEqual(await treeDigest(root), before, "the old tree is byte-identical, mtimes included");
  for (const args of [
    ["project-create", "--workspace", root, "--at", at(), "--external-key", "LEGACY-NEW", "--name", "New"],
    ["work-transition", "--workspace", root, "--at", at(), "--id", expected.records.story.id, "--status", "done"],
    ["settings-set", "--workspace", root, "--at", at(), "--key", "retrieval.tau", "--value", "3"],
    ["recover", "--workspace", root, "--at", at()],
  ]) {
    const error = await refusal(device, args);
    assert.equal(error.reasonCode, "LEGACY_WORKSPACE_READ_ONLY", args[0]);
    assert.equal(error.details.remedy, "library-import-legacy");
  }
  assert.deepEqual(await treeDigest(root), before, "no refused write left a trace");
  const nowhere = await refusal(device, ["status", "--workspace", base]);
  assert.equal(nowhere.reasonCode, "LIBRARY_NOT_FOUND");
});

test("467-AC3: an event byte changed in place in an akasha segment is reported with its device and sequence", async (context) => {
  const base = await scratch(context);
  const device = join(base, "device");
  const library = join(base, ".ether");
  await as(device, ["init", "--workspace", library, "--at", at()]);
  await seed(device, library, "TAMPER");
  const deviceId = await deviceIdOf(device);
  const segment = join(library, "akasha", deviceId, "00000001.ndjson");
  const text = await readFile(segment, "utf8");
  await writeFile(segment, text.replace("Initiative TAMPER-INITIATIVE", "Initiative TAMPER-INITIATIVF"));
  const error = await refusal(device, ["chain-validate", "--workspace", library]);
  assert.equal(error.reasonCode, "AKASHA_EVENT_CORRUPT");
  assert.equal(error.details.deviceId, deviceId);
  assert.equal(error.details.sequence, "2");
  assert.equal(error.details.break, "payloadHash");
  const child = spawnSync(process.execPath, [cliPath, "chain-validate", "--workspace", library], { encoding: "utf8", env: { ...process.env, EINZBERN_HOME: device } });
  assert.equal(child.status, 1);
  const reported = JSON.parse(child.stderr);
  assert.deepEqual([reported.reasonCode, reported.deviceId, reported.sequence], ["AKASHA_EVENT_CORRUPT", deviceId, "2"]);
});
