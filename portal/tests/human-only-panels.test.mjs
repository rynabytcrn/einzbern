// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-541 GWT2, GWT3, GWT6 (MIN-258 D3; TCRN-CROSS-SUB-513): the three writes a person used to
// make in a terminal are made in Atelier. The Library tab declares the selected library's chain identity
// (chain-declare, which runs for Atelier only: the same command from a model is refused, citing a decision or
// not); the Gates page releases a gate a migration carried over, and only with a reason, recording who, when
// and why with surface atelier; the Library tab takes a registry entry out as library-unregister does, its plan
// first and the removal once confirmed, after registry.json is backed up, and never the selected entry.
// Everything here is temporary: each fixture's libraries, device directory and HOME, removed with it.

import "../../tests/helpers/device-home.mjs";
import { appendHistoricalGateCreate } from "../../tests/helpers/workspace-fixture.mjs";
import { portalFixture } from "./helpers/portal-fixture.mjs";
import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";

const execFileAsync = promisify(execFile);
const portalRoot = fileURLToPath(new URL("..", import.meta.url));
const CLI = process.env.TCRN_WORKFLOW_CLI ?? join(portalRoot, "..", "scripts", "einzbern.mjs");
const ACTOR = "agent:test-portal";
// The portal is a loopback server on this machine; the offline boundary allows the page's requests to
// it, made as the page makes them, through the platform's request function.
const loopback = globalThis.fetch;

let second = 0;
const at = () => { second += 1; return new Date(Date.UTC(2026, 9, 15, 3, 0, second)).toISOString().replace(".000Z", "Z"); };

async function cli(args, env = {}) {
  const { stdout } = await execFileAsync(process.execPath, [CLI, ...args], { encoding: "utf8", maxBuffer: 32e6, env: { ...process.env, ...env } });
  return JSON.parse(stdout);
}

// A command the CLI refuses: its one JSON line on stderr.
async function refusal(args, env = {}) {
  try {
    await execFileAsync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
  } catch (error) {
    return JSON.parse(String(error.stderr).trim().split("\n").at(-1));
  }
  throw new Error(`expected ${args[0]} to be refused`);
}

async function registeredLibrary(deviceEnv, project, library, externalKey) {
  await mkdir(project, { recursive: true });
  await cli(["init", "--workspace", library, "--project-name", externalKey, "--at", at()], deviceEnv);
  const projectId = (await cli(["project-create", "--workspace", library, "--external-key", externalKey + "-PROJECT", "--name", externalKey, "--at", at()], deviceEnv)).record.id;
  await cli(["library-register", "--project", project, "--library", library, "--project-id", projectId, "--at", at()], deviceEnv);
  const libraryId = (await cli(["status", "--workspace", library], deviceEnv)).workspaceId;
  return { project, library, projectId, libraryId };
}

// A device of its own with three registered libraries: the first, opened by Atelier and kept in its project;
// a second kept outside its project; and a third whose library is later moved away. Atelier starts on the first.
async function fixture(context, prefix) {
  const { base, start } = await portalFixture(context, prefix);
  const home = join(base, "home");
  await mkdir(home);
  const deviceEnv = { EINZBERN_HOME: join(base, "device", "einzbern") };
  const first = await registeredLibrary(deviceEnv, join(base, "project"), join(base, "project", ".ether"), "HUMAN-ONLY");
  const other = await registeredLibrary(deviceEnv, join(base, "second-project"), join(base, "second-library"), "HUMAN-ONLY-SECOND");
  const gone = await registeredLibrary(deviceEnv, join(base, "third-project"), join(base, "third-library"), "HUMAN-ONLY-THIRD");
  const { url } = await start([join(portalRoot, "portal.mjs"), "--library", first.library, "--port", "0"], {
    env: { ...process.env, TCRN_WORKFLOW_CLI: CLI, TCRN_PORTAL_ACTOR: ACTOR, ...deviceEnv, HOME: home },
  });
  const page = await (await loopback(url)).text();
  const boot = JSON.parse(page.match(/const BOOT = (\{.*\});/u)[1]);
  // The target the page names, as the page keeps it: taken again from every switch it makes.
  let target = { epoch: boot.epoch, libraryId: boot.library.libraryId, projectId: boot.library.configurationProjectId ?? null };
  const call = async (path, method, body) => {
    const options = method === "GET"
      ? { headers: { "x-portal-token": boot.token } }
      : { method, headers: { "content-type": "application/json", "x-portal-token": boot.token, "x-configuration-target": JSON.stringify(target) }, body: JSON.stringify(body) };
    const response = await loopback(new URL(path, url), options);
    const answer = await response.json();
    if (path === "/api/library" && answer.ok) target = { epoch: answer.epoch, libraryId: answer.library.libraryId, projectId: answer.library.configurationProjectId ?? null };
    return { status: response.status, body: answer };
  };
  return { base, deviceEnv, first, other, gone, boot, call };
}

// The events appended after `from`, through the CLI's event page.
const eventCount = async (f, library) => (await cli(["event-list", "--workspace", library, "--limit", "1"], f.deviceEnv)).total;
const eventsSince = async (f, library, from) => (await cli(["event-list", "--workspace", library, "--offset", String(from)], f.deviceEnv)).records.map((record) => record.payload);

test("541 GWT2: the Library tab declares the selected library's chain identity through chain-declare for Atelier, which a model's run of the same command is refused", async (context) => {
  const f = await fixture(context, "portal-541-chain-");
  assert.equal(f.boot.library.chain, null, "the fixture's library has declared no identity yet");
  const declare = (library, role, coordinationLibraryId) => ["chain-declare", "--workspace", library, "--role", role, "--coordination-library-id", coordinationLibraryId, "--at", at(), "--actor", "agent:model"];
  // A model's run is refused, and so is one citing a decision: the hard constraint stays, and its remedy names this page.
  const refused = await refusal(declare(f.first.library, "coordination", f.first.libraryId), f.deviceEnv);
  assert.deepEqual([refused.reasonCode, refused.details?.remedy ?? refused.remedy], ["MODEL_WRITE_REFUSED", "declare it on the library page in Atelier"]);

  let from = await eventCount(f, f.first.library);
  const declared = await f.call("/api/chain-identity", "POST", { role: "coordination", coordinationLibraryId: f.first.libraryId });
  assert.equal(declared.status, 200, JSON.stringify(declared.body));
  assert.deepEqual([declared.body.ok, declared.body.library.chain], [true, { role: "coordination", coordinationLibraryId: f.first.libraryId }]);
  assert.deepEqual((await cli(["chain-identity", "--workspace", f.first.library], f.deviceEnv)).identity, { role: "coordination", coordinationLibraryId: f.first.libraryId });
  const [event] = (await eventsSince(f, f.first.library, from)).filter((entry) => entry.record?.collection === "chain");
  assert.deepEqual([event?.operation, event?.record.key, event?.record.value.role], ["config.record.set", "identity", "coordination"], "the identity is written into the library");
  const listed = await f.call("/api/libraries", "GET");
  assert.equal(listed.body.selected.chain.role, "coordination", "the selection takes the role its library now has");

  // Another library, selected, is declared a project library belonging to the coordination library.
  const switched = await f.call("/api/library", "POST", { library: f.other.library });
  assert.equal(switched.status, 200, JSON.stringify(switched.body));
  from = await eventCount(f, f.other.library);
  const project = await f.call("/api/chain-identity", "POST", { role: "project", coordinationLibraryId: f.first.libraryId });
  assert.equal(project.status, 200, JSON.stringify(project.body));
  assert.deepEqual((await cli(["chain-identity", "--workspace", f.other.library], f.deviceEnv)).identity, { role: "project", coordinationLibraryId: f.first.libraryId });
  assert.equal((await eventsSince(f, f.other.library, from)).filter((entry) => entry.record?.collection === "chain").length, 1);
  // A role the engine does not know is refused and nothing is written.
  from = await eventCount(f, f.other.library);
  const malformed = await f.call("/api/chain-identity", "POST", { role: "owner", coordinationLibraryId: f.first.libraryId });
  assert.deepEqual([malformed.status, malformed.body.ok, malformed.body.reasonCode], [409, false, "CLI_ARGUMENT_MALFORMED"]);
  assert.equal(await eventCount(f, f.other.library), from);
});

test("541 GWT2: the Gates page lists a migrated gate, refuses a release without a reason, and releases it for Atelier recording who, when and why", async (context) => {
  const f = await fixture(context, "portal-541-gates-");
  const previous = process.env.EINZBERN_HOME;
  process.env.EINZBERN_HOME = f.deviceEnv.EINZBERN_HOME;
  try {
    await appendHistoricalGateCreate(f.first.library, { externalKey: "HUMAN-ONLY-GATE-1", projectId: f.first.projectId, workId: null, title: "Owner intent gate", outcomeClass: "owner_intent_required", occurredAt: at() });
  } finally { process.env.EINZBERN_HOME = previous; }
  const listed = await f.call("/api/migrated-gates", "GET");
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.deepEqual(listed.body.gates.map((gate) => [gate.title, gate.status]), [["Owner intent gate", "pending"]]);
  assert.deepEqual(listed.body.released, []);
  const [gate] = listed.body.gates;

  const before = await eventCount(f, f.first.library);
  for (const reason of [undefined, "", "   "]) {
    const refused = await f.call("/api/migrated-gates/release", "POST", { id: gate.id, ...(reason === undefined ? {} : { reason }) });
    assert.deepEqual([refused.status, refused.body.ok, refused.body.reasonCode], [400, false, "PORTAL_GATE_RELEASE_REASON_REQUIRED"], JSON.stringify(reason));
  }
  assert.equal(await eventCount(f, f.first.library), before, "a release without a reason writes nothing");

  const reason = "The Owner accepted the Story by hand; the old conference gate is obsolete.";
  const released = await f.call("/api/migrated-gates/release", "POST", { id: gate.id, reason });
  assert.equal(released.status, 200, JSON.stringify(released.body));
  assert.deepEqual([released.body.ok, released.body.record.id, released.body.record.status], [true, gate.id, "satisfied"]);
  const [event] = await eventsSince(f, f.first.library, before);
  assert.deepEqual([event.operation, event.surface, Object.hasOwn(event, "decidedIn")], ["gate.updated", "atelier", false], "the release is recorded for Atelier, citing no decision");
  const entry = event.record.extensions["gate-evidence:atelier-release"].value;
  assert.deepEqual([entry.actor, entry.reason, entry.releasedAt], [ACTOR, reason, event.record.updatedAt], "who, why and when");

  const after = await f.call("/api/migrated-gates", "GET");
  assert.deepEqual(after.body.gates, [], "the released gate holds nothing back");
  assert.deepEqual(after.body.released.map((record) => [record.id, record.extensions["gate-evidence:atelier-release"].value.actor]), [[gate.id, ACTOR]]);
  const again = await f.call("/api/migrated-gates/release", "POST", { id: gate.id, reason });
  assert.deepEqual([again.status, again.body.ok], [409, false], "a released gate is not released twice");
});

test("541 GWT3: the Library tab shows whether each entry's paths exist and takes one out after its plan, backing registry.json up first; the selected entry is refused", async (context) => {
  const f = await fixture(context, "portal-541-registry-");
  // The third library is moved away, as a library deleted by hand is: its entry stays, its path is gone.
  await rename(f.gone.library, join(f.base, "third-library-moved"));
  const listed = await f.call("/api/libraries", "GET");
  assert.deepEqual(listed.body.paths, [
    { projectPath: f.first.project, projectPathExists: true, libraryPathExists: true },
    { projectPath: f.other.project, projectPathExists: true, libraryPathExists: true },
    { projectPath: f.gone.project, projectPathExists: true, libraryPathExists: false },
  ].sort((left, right) => left.projectPath < right.projectPath ? -1 : 1), "in the registry's order, with each path's existence");
  assert.deepEqual(listed.body.libraries.map((library) => library.projectPath), listed.body.paths.map((entry) => entry.projectPath));

  const selected = await f.call("/api/libraries/unregister", "POST", { projectPath: f.first.project });
  assert.deepEqual([selected.status, selected.body.reasonCode], [409, "PORTAL_LIBRARY_UNREGISTER_SELECTED"], "the selected entry is not taken out");

  const backups = join(f.deviceEnv.EINZBERN_HOME, "backups");
  const backupsNow = async () => (await readdir(backups).catch(() => [])).filter((name) => name.endsWith("-library-unregister"));
  const plan = await f.call("/api/libraries/unregister", "POST", { projectPath: f.gone.project });
  assert.equal(plan.status, 200, JSON.stringify(plan.body));
  assert.deepEqual([plan.body.reasonCode, plan.body.confirmed, plan.body.entry.projectPath, plan.body.libraryPathExists, plan.body.remaining], ["LIBRARY_UNREGISTER_PLAN_READY", false, f.gone.project, false, 2]);
  assert.deepEqual(await backupsNow(), [], "the plan writes nothing");
  assert.equal((await cli(["library-list"], f.deviceEnv)).entries.length, 3);

  const removed = await f.call("/api/libraries/unregister", "POST", { projectPath: f.gone.project, confirm: true });
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.deepEqual([removed.body.reasonCode, removed.body.confirmed], ["LIBRARY_UNREGISTERED", true]);
  const [backup] = await backupsNow();
  assert.ok(backup, "registry.json is backed up first");
  assert.equal(JSON.parse(await readFile(join(backups, backup, "registry.json"), "utf8")).entries.length, 3, "the backup is the registry as it stood");
  assert.deepEqual((await cli(["library-list"], f.deviceEnv)).entries.map((entry) => entry.projectPath).sort(), [f.first.project, f.other.project].sort());
  assert.deepEqual(removed.body.libraries.map((library) => library.projectPath).sort(), [f.first.project, f.other.project].sort(), "the page is given the registry as it now stands");
  const missing = await f.call("/api/libraries/unregister", "POST", { projectPath: f.gone.project });
  assert.deepEqual([missing.status, missing.body.reasonCode], [409, "LIBRARY_NOT_REGISTERED"]);
});
