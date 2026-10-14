// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-538 GWT1, the proposals' part, and GWT7 (MIN-256 D6 C2, C3; TCRN-CROSS-SUB-497):
// proposing, rejecting and approving hold the library write lock for their append alone. While
// another process holds the lock for 3 seconds, gates-config-propose, rule-propose, proposal-approve
// and proposal-reject (run for Atelier) read and check without waiting for it -- a refusal comes back
// at once -- and a write that passes its checks waits for the lock, lands once it is free, and its
// receipt is the one it always was. An approval that read a proposal another writer settles before
// the approval appends is refused at its append with the reason code it gets today, and appends
// nothing; a rule's approval settles only the proposal it read. Every library, project and device
// directory here is a temporary one.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { approveProposal, createProject, initializeLibrary, listProposals, materializeWorkspace } from "../dist/build/packages/core/src/index.js";
import { BUILT_IN_RULES } from "../dist/build/packages/core/src/rules-catalog.js";
import { ATELIER_SURFACE, cli, cliProcess, instant, withSurface, workspaceFixture } from "./helpers/workspace-fixture.mjs";

const workspaceModule = new URL("../dist/build/packages/core/src/workspace.js", import.meta.url).href;
const coreModule = new URL("../dist/build/packages/core/src/index.js", import.meta.url).href;

const MODEL = "agent:proposals-lock-model";
const OWNER = "owner:governance";
const RULE = BUILT_IN_RULES[0].id;
const OTHER_RULE = BUILT_IN_RULES[1].id;
const USER_TEXT = "# Proposals lock fixture\n\nThe user's own notes.\n";
const GATE_COMMAND = JSON.stringify(["node", "--version"]);

// Resolves once `stream` has printed `line`; rejects when `exited` settles first.
function lineWaiter(stream, exited) {
  let text = "";
  const waiting = [];
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    text += chunk;
    for (const entry of [...waiting]) {
      if (!text.includes(entry.line)) continue;
      waiting.splice(waiting.indexOf(entry), 1);
      entry.resolve();
    }
  });
  return (line) => Promise.race([
    text.includes(line) ? Promise.resolve() : new Promise((resolve) => { waiting.push({ line, resolve }); }),
    exited.then(() => { throw new Error(`the lock holder exited before it printed ${line}`); }),
  ]);
}

/**
 * Another process that takes the library's write lock, as a write verb does, and gives it back
 * `milliseconds` after it took it. Given `during` -- statements run with the core module as `core` --
 * it waits under the lock until write() is called, runs them there, as another writer whose turn came
 * first would, and only then lets the rest of the time run out.
 */
async function holdLibraryLock(context, workspace, milliseconds, during = null) {
  const script = `import { withWorkspaceWriteLock } from ${JSON.stringify(workspaceModule)};
import * as core from ${JSON.stringify(coreModule)};
import { once } from "node:events";
await withWorkspaceWriteLock(${JSON.stringify(workspace)}, async () => {
  const heldAt = Date.now();
  process.stdout.write("held\\n");
  ${during === null ? "" : `await once(process.stdin, "data");
  ${during}
  process.stdout.write("written\\n");`}
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, ${milliseconds} - (Date.now() - heldAt))));
}, { command: "einzbern work-annotate" });`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: [during === null ? "ignore" : "pipe", "pipe", "pipe"], env: process.env });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exited = once(child, "exit").then(([code]) => {
    assert.equal(code, 0, stderr);
    return Date.now();
  });
  context.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await exited.catch(() => undefined);
  });
  const printed = lineWaiter(child.stdout, exited);
  await printed("held");
  return {
    heldAt: Date.now(),
    released: exited,
    async write() {
      child.stdin.end("write\n");
      await printed("written");
    },
  };
}

async function timed(operation) {
  const started = Date.now();
  const result = await operation();
  return { result, elapsed: Date.now() - started };
}

function settle(promise) {
  const state = { done: false };
  return { state, promise: promise.then((value) => { state.done = true; return value; }, (error) => { state.done = true; throw error; }) };
}

const pause = (milliseconds) => new Promise((resolve) => { setTimeout(resolve, milliseconds); });

async function refusal(operation) {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  throw new Error("the operation was expected to refuse");
}

const asModel = (operation) => withSurface(undefined, operation);
const asAtelier = (operation) => withSurface(ATELIER_SURFACE, operation);
const proposeGate = (workspace, projectId, name, second) => asModel(() => cli(["gates-config-propose", "--workspace", workspace, "--project-id", projectId,
  "--at", instant(second), "--name", name, "--command", GATE_COMMAND, "--actor", MODEL]));
const proposeRule = (workspace, projectId, id, second) => asModel(() => cli(["rule-propose", "--workspace", workspace, "--project-id", projectId,
  "--id", id, "--at", instant(second), "--actor", MODEL]));
const settleArgs = (verb, workspace, projectId, key, proposedAt, second) => [verb, "--workspace", workspace, "--project-id", projectId,
  "--key", key, "--proposed-at", proposedAt, "--at", instant(second), "--actor", OWNER];

test("538 GWT1: while another process holds the library write lock, a proposal write's reads and checks refuse at once, without waiting for it", async (context) => {
  const { workspace, projectId } = await workspaceFixture(context, { externalKey: "PROPOSALS-LOCK-CHECKS" });
  const first = await proposeGate(workspace, projectId, "stale", 2);
  const again = await proposeGate(workspace, projectId, "stale", 3);
  const rule = await proposeRule(workspace, projectId, RULE, 4);
  await proposeRule(workspace, projectId, RULE, 5);
  const before = await materializeWorkspace(workspace);
  const holder = await holdLibraryLock(context, workspace, 3000);

  const refusals = [
    ...await asModel(async () => [
      ["gates-config-propose", "CONFIG_RECORD_NOT_FOUND", await timed(() => refusal(() => cli(["gates-config-propose", "--workspace", workspace, "--project-id", projectId,
        "--at", instant(6), "--name", "undeclared", "--action", "remove", "--actor", MODEL])))],
      ["rule-propose", "RULE_UNKNOWN", await timed(() => refusal(() => cli(["rule-propose", "--workspace", workspace, "--project-id", projectId,
        "--id", "no-such-rule", "--at", instant(6), "--actor", MODEL])))],
    ]),
    ...await asAtelier(async () => [
      ["proposal-approve of a gate", "PROPOSAL_STALE", await timed(() => refusal(() => cli(settleArgs("proposal-approve", workspace, projectId, "gate:stale", first.proposal.proposedAt, 6))))],
      ["proposal-approve of a rule", "PROPOSAL_STALE", await timed(() => refusal(() => cli(settleArgs("proposal-approve", workspace, projectId, `rule:${RULE}`, rule.proposal.proposedAt, 6))))],
      ["proposal-approve of nothing", "PROPOSAL_NOT_FOUND", await timed(() => refusal(() => cli(settleArgs("proposal-approve", workspace, projectId, "gate:absent", first.proposal.proposedAt, 6))))],
      ["proposal-reject", "PROPOSAL_STALE", await timed(() => refusal(() => cli(settleArgs("proposal-reject", workspace, projectId, "gate:stale", first.proposal.proposedAt, 6))))],
    ]),
  ];
  assert.ok(Date.now() - holder.heldAt < 3000, "every refusal came while the lock was held");
  for (const [name, reasonCode, run] of refusals) {
    assert.equal(run.result.reasonCode, reasonCode, `${name}: ${run.result.message}`);
    assert.ok(run.elapsed < 1000, `${name} refused in ${run.elapsed} ms`);
  }
  assert.deepEqual([refusals[2][2].result.details.required, refusals[2][2].result.details.actual], [again.proposal.proposedAt, first.proposal.proposedAt]);
  await holder.released;
  const after = await materializeWorkspace(workspace);
  assert.equal(after.version, before.version, "a refused proposal write appends nothing");
});

test("538 GWT1: a proposal write that passes its checks waits for the lock, lands once it is free, and its receipt names only what it wrote", async (context) => {
  const { workspace, projectId } = await workspaceFixture(context, { externalKey: "PROPOSALS-LOCK-WAIT" });
  const approvable = await proposeGate(workspace, projectId, "approvable", 2);
  const rejectable = await proposeGate(workspace, projectId, "rejectable", 3);
  const before = await materializeWorkspace(workspace);
  const holder = await holdLibraryLock(context, workspace, 1500);
  const model = { env: { EINZBERN_SURFACE: "" } };
  const atelier = { env: { EINZBERN_SURFACE: ATELIER_SURFACE } };
  const writes = {
    gate: settle(cliProcess(["gates-config-propose", "--workspace", workspace, "--project-id", projectId, "--at", instant(4), "--name", "waiting",
      "--command", GATE_COMMAND, "--actor", MODEL], model)),
    rule: settle(cliProcess(["rule-propose", "--workspace", workspace, "--project-id", projectId, "--id", OTHER_RULE, "--at", instant(5), "--actor", MODEL], model)),
    approve: settle(cliProcess(settleArgs("proposal-approve", workspace, projectId, "gate:approvable", approvable.proposal.proposedAt, 6), atelier)),
    reject: settle(cliProcess(settleArgs("proposal-reject", workspace, projectId, "gate:rejectable", rejectable.proposal.proposedAt, 7), atelier)),
  };
  await pause(700);
  assert.deepEqual(Object.entries(writes).filter(([, write]) => write.state.done).map(([name]) => name), [], "the writes wait while the lock is held");
  await holder.released;
  const receipts = {};
  for (const [name, write] of Object.entries(writes)) {
    const run = await write.promise;
    assert.equal(run.status, 0, `${name}: ${run.stderr}`);
    receipts[name] = JSON.parse(run.stdout);
    assert.equal(receipts[name].reasonCode, "WORKSPACE_COMMAND_COMPLETED", name);
  }
  assert.deepEqual([receipts.gate.proposal.key, receipts.gate.proposal.status, receipts.gate.proposal.proposedBy], ["gate:waiting", "pending", MODEL]);
  assert.deepEqual([receipts.rule.proposal.key, receipts.rule.proposal.status], [`rule:${OTHER_RULE}`, "pending"]);
  assert.deepEqual([receipts.approve.approved.key, receipts.approve.approved.proposedAt], ["gate:approvable", approvable.proposal.proposedAt]);
  assert.deepEqual([receipts.reject.proposal.key, receipts.reject.proposal.status, receipts.reject.proposal.rejectedBy], ["gate:rejectable", "rejected", OWNER]);
  assert.deepEqual(Object.fromEntries(Object.entries(receipts).map(([name, receipt]) => [name, receipt.ids.length])), { gate: 1, rule: 1, approve: 2, reject: 1 },
    "each receipt names the records its own append wrote: an approval the gate and the proposal");
  const named = Object.values(receipts).flatMap((receipt) => receipt.ids);
  assert.equal(new Set(named).size, named.length, "no receipt names a record another write wrote");

  const after = await materializeWorkspace(workspace);
  assert.equal(after.version, before.version + 5, "every write landed once the lock was free");
  assert.deepEqual(listProposals(after, { projectId }).map((proposal) => [proposal.key, proposal.status]), [
    ["gate:rejectable", "rejected"], ["gate:waiting", "pending"], [`rule:${OTHER_RULE}`, "pending"],
  ]);
  const declared = after.events.find((event) => event.payload.operation === "config.record.set" && event.payload.record.collection === "gate");
  assert.deepEqual([declared.payload.record.key, declared.payload.surface, declared.payload.decidedIn], ["approvable", "atelier", `proposal:gate:approvable@${approvable.proposal.proposedAt}`]);
  assert.match(await readFile(join(workspace, "config", "project.json"), "utf8"), /"approvable"/u, "config/project.json shows the approved gate");
});

test("538 GWT1: an approval that read a proposal another writer approves before its append is refused at its append, PROPOSAL_NOT_FOUND, and appends nothing", async (context) => {
  const { workspace, projectId } = await workspaceFixture(context, { externalKey: "PROPOSALS-LOCK-RACE" });
  const proposed = await proposeGate(workspace, projectId, "racing", 2);
  const before = await materializeWorkspace(workspace);
  const holder = await holdLibraryLock(context, workspace, 3000, `await core.approveProposal({ libraryRoot: ${JSON.stringify(workspace)}, key: "gate:racing",
    proposedAt: ${JSON.stringify(proposed.proposal.proposedAt)}, occurredAt: ${JSON.stringify(instant(3))}, actorId: ${JSON.stringify(OWNER)},
    configurationProjectId: ${JSON.stringify(projectId)} });`);
  const late = settle(asAtelier(() => cli(settleArgs("proposal-approve", workspace, projectId, "gate:racing", proposed.proposal.proposedAt, 4)))
    .then(() => null, (error) => error));
  await pause(1000);
  assert.equal(late.state.done, false, "the approval read the pending proposal and waits for the lock to append");
  await holder.write();
  await pause(300);
  assert.equal(late.state.done, false, "it passed its checks before the other approval landed, so it still waits");
  const releasedAt = await holder.released;
  const refused = await late.promise;
  assert.ok(Date.now() >= releasedAt, "the refusal came at the append, once the lock was free");
  assert.equal(refused?.reasonCode, "PROPOSAL_NOT_FOUND", refused?.message);
  const after = await materializeWorkspace(workspace);
  assert.equal(after.version, before.version + 2, "only the first approval appended: the gate and the proposal's removal");
  assert.deepEqual(after.events.slice(-2).map((event) => [event.payload.operation, event.payload.record.collection]), [
    ["config.record.set", "gate"], ["config.record.removed", "proposal"],
  ]);
  assert.deepEqual(listProposals(after, { projectId }), []);
});

test("538 GWT1: a rule's approval settles only the proposal it read; one proposed again at the same instant before its append is PROPOSAL_STALE and AGENTS.md is put back", async (context) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-proposals-lock-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const project = join(base, "project");
  await mkdir(project);
  const agents = join(project, "AGENTS.md");
  await writeFile(agents, USER_TEXT);
  const library = join(base, ".ether");
  await initializeLibrary({ root: library, createdAt: instant(0) });
  const created = await createProject(library, { externalKey: "PROPOSALS-LOCK-RULE", name: "Proposals lock fixture", occurredAt: instant(1) });
  const projectId = created.projects.find((entry) => entry.externalKey === "PROPOSALS-LOCK-RULE").id;
  const proposedAt = instant(2);
  await asModel(() => cli(["rule-propose", "--workspace", library, "--project-id", projectId, "--id", RULE, "--order", "2", "--at", proposedAt, "--actor", MODEL]));
  const before = await materializeWorkspace(library);
  const holder = await holdLibraryLock(context, library, 3000, `await core.proposeChange(${JSON.stringify(library)}, { kind: "rule", target: ${JSON.stringify(RULE)},
    action: "enable", payload: { order: 3 }, proposedBy: ${JSON.stringify(MODEL)}, actorId: ${JSON.stringify(MODEL)}, occurredAt: ${JSON.stringify(proposedAt)},
    configurationProjectId: ${JSON.stringify(projectId)} });`);
  const approval = settle(approveProposal({ libraryRoot: library, key: `rule:${RULE}`, proposedAt, occurredAt: instant(4), actorId: OWNER,
    configurationProjectId: projectId, projectRoot: project, backupRoot: join(base, "device", "backups") }).then(() => null, (error) => error));
  await pause(1000);
  assert.equal(approval.state.done, false, "the approval read the proposal and waits for the lock");
  await holder.write();
  await holder.released;
  const refused = await approval.promise;
  assert.equal(refused?.reasonCode, "PROPOSAL_STALE", refused?.message);
  assert.deepEqual([refused.details.target, refused.details.required, refused.details.actual], [`rule:${RULE}`, proposedAt, proposedAt]);
  assert.equal(await readFile(agents, "utf8"), USER_TEXT, "AGENTS.md is put back");
  const after = await materializeWorkspace(library);
  assert.equal(after.version, before.version + 1, "only the proposal written again was appended");
  assert.deepEqual(listProposals(after, { projectId }).map((proposal) => [proposal.key, proposal.status, proposal.payload]), [[`rule:${RULE}`, "pending", { order: 3 }]]);
  assert.equal(after.configRecords.some((record) => record.collection === "rule"), false, "the rule is not enabled");
});
