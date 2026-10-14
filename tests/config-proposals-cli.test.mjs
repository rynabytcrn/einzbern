// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-527 GWT1, GWT3, GWT4 and the CLI's part of GWT2 (MIN-257 D6, Q5, Q6;
// TCRN-CROSS-SUB-478). A model proposes a gate declaration with gates-config-propose and a rule change
// with rule-propose, and is not refused; gates-config-list and rule-list read the proposals with
// --status pending or rejected, and their default lists do not show them. A pending gate is not
// planned for a release, and a pending rule is neither enabled nor rendered. proposal-approve and
// proposal-reject run for Atelier only: a model's run is MODEL_WRITE_REFUSED and appends nothing.
// Atelier's approval declares the gate (or enables the rule and writes its section) with the
// authorization Q5 settles; a rejected proposal is PROPOSAL_NOT_PENDING to an approval. Every
// project, library and device directory here is a temporary one.

import "./helpers/device-home.mjs";
import { ATELIER_SURFACE, withSurface } from "./helpers/workspace-fixture.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { MODEL_WRITE_REMEDY, runCli } from "../dist/build/packages/cli/src/index.js";
import { materializeWorkspace } from "../dist/build/packages/core/src/workspace.js";
import { BUILT_IN_RULES } from "../dist/build/packages/core/src/rules-catalog.js";

const repositoryRoot = resolve(import.meta.dirname, "..");
const ENTRY = join(repositoryRoot, "scripts/einzbern.mjs");
const USER_TEXT = "# Proposals project\n\nThe user's own notes.\n";
const MODEL = "agent:proposals-model";
const OWNER = "owner:governance";
const RULE = BUILT_IN_RULES[0].id;

let second = 0;
const at = () => {
  second += 1;
  return new Date(Date.UTC(2026, 9, 14, 11, 0, second)).toISOString().replace(".000Z", "Z");
};

async function cli(args) {
  let output = "";
  await runCli(args, { write: (value) => { output += value; } });
  return JSON.parse(output);
}

async function refusal(args) {
  try {
    await cli(args);
  } catch (error) {
    return error;
  }
  throw new Error(`${args[0]} was expected to refuse`);
}

const asModel = (operation) => withSurface(undefined, operation);
const asAtelier = (operation) => withSurface(ATELIER_SURFACE, operation);

/** A registered project with an AGENTS.md of the user's own, its library in .ether, and its project id. */
async function scratch(context) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-proposals-cli-")));
  const previous = process.env.EINZBERN_HOME;
  const device = join(base, "device");
  process.env.EINZBERN_HOME = device;
  context.after(async () => {
    process.env.EINZBERN_HOME = previous;
    await rm(base, { recursive: true, force: true });
  });
  const project = join(base, "project");
  await mkdir(join(project, "src"), { recursive: true });
  await writeFile(join(project, "AGENTS.md"), USER_TEXT);
  const library = join(project, ".ether");
  await cli(["init", "--workspace", library, "--at", at(), "--project", project]);
  const created = await cli(["project-create", "--workspace", library, "--external-key", "proposals-project", "--name", "Proposals project", "--at", at()]);
  await cli(["library-register", "--library", library, "--project", project, "--project-id", created.record.id, "--at", at()]);
  return { base, device, project, library, projectId: created.record.id, agents: join(project, "AGENTS.md") };
}

const proposeGate = (paths, name, covers = "src/**") => asModel(() => cli(["gates-config-propose", "--workspace", paths.library, "--project-id", paths.projectId, "--at", at(), "--name", name, "--command", JSON.stringify(["node", "--version"]), "--covers", covers, "--actor", MODEL]));
const listGateRecords = (paths, status) => cli(["gates-config-list", "--workspace", paths.library, "--project-id", paths.projectId, ...(status === undefined ? [] : ["--status", status])]);
const settle = (verb, paths, key, proposedAt, extra = ["--workspace", paths.library, "--project-id", paths.projectId]) => cli([verb, "--key", key, "--proposed-at", proposedAt, "--at", at(), "--actor", OWNER, ...extra]);

test("527 GWT1: a model proposes a gate; gates-config-list --status pending reads it and the default list does not", async (context) => {
  const paths = await scratch(context);
  const proposed = await proposeGate(paths, "unit");
  assert.equal(proposed.reasonCode, "WORKSPACE_COMMAND_COMPLETED");
  assert.deepEqual([proposed.proposal.key, proposed.proposal.status, proposed.proposal.action, proposed.proposal.proposedBy], ["gate:unit", "pending", "set", MODEL]);
  assert.deepEqual(proposed.proposal.payload, { command: ["node", "--version"], root: ".", covers: ["src/**"], required: true, enabled: true, releaseOnly: false });
  await asModel(async () => {
    assert.deepEqual((await listGateRecords(paths)).records, [], "the default list holds the declarations only");
    assert.deepEqual((await listGateRecords(paths, "declared")).records, []);
    const pending = await listGateRecords(paths, "pending");
    assert.deepEqual([pending.kind, pending.records.map((record) => record.key)], ["proposal", ["gate:unit"]]);
    assert.deepEqual((await listGateRecords(paths, "rejected")).records, []);
    assert.equal((await refusal(["gates-config-list", "--workspace", paths.library, "--status", "waiting"])).reasonCode, "CLI_ARGUMENT_MALFORMED");
  });
  // A removal names nothing but the gate, and only a declared one.
  assert.equal((await refusal(["gates-config-propose", "--workspace", paths.library, "--project-id", paths.projectId, "--at", at(), "--name", "unit", "--action", "remove", "--actor", MODEL])).reasonCode, "CONFIG_RECORD_NOT_FOUND");
  assert.equal((await refusal(["gates-config-propose", "--workspace", paths.library, "--at", at(), "--name", "unit", "--action", "remove", "--covers", "x", "--actor", MODEL])).reasonCode, "CLI_ARGUMENT_MALFORMED");
  assert.equal((await refusal(["gates-config-propose", "--workspace", paths.library, "--at", at(), "--name", "unit", "--command", "[]", "--actor", MODEL])).reasonCode, "GATES_CONFIG_INVALID");
  assert.equal((await refusal(["gates-config-propose", "--workspace", paths.library, "--at", at(), "--name", "unit", "--command", "[\"node\"]"])).reasonCode, "CLI_ARGUMENT_MISSING", "a proposal names who proposed it");
});

test("527 GWT3: a pending gate is not planned for a release; a pending rule is neither enabled nor rendered", async (context) => {
  const paths = await scratch(context);
  await asAtelier(() => cli(["gates-config-set", "--workspace", paths.library, "--project-id", paths.projectId, "--at", at(), "--name", "declared", "--command", JSON.stringify(["node", "--version"])]));
  await proposeGate(paths, "unit");
  const plan = await cli(["gates-plan", "--workspace", paths.library, "--project", paths.project, "--project-id", paths.projectId, "--release", "true"]);
  assert.deepEqual(plan.gates.map((gate) => gate.name), ["declared"], "a release plan does not choose a pending gate");

  const proposed = await asModel(() => cli(["rule-propose", "--project", paths.project, "--id", RULE, "--order", "3", "--at", at(), "--actor", MODEL]));
  assert.deepEqual([proposed.proposal.key, proposed.proposal.action, proposed.proposal.payload], [`rule:${RULE}`, "enable", { order: 3 }]);
  await asModel(async () => {
    const listed = await cli(["rule-list", "--project", paths.project]);
    assert.equal(listed.rules.find((rule) => rule.id === RULE).state, "disabled", "a proposed rule is not enabled");
    const pending = await cli(["rule-list", "--project", paths.project, "--status", "pending"]);
    assert.deepEqual(pending.records.map((record) => [record.key, record.status]), [[`rule:${RULE}`, "pending"]]);
    assert.deepEqual((await cli(["rule-list", "--workspace", paths.library, "--project-id", paths.projectId, "--status", "pending"])).records.length, 1);
  });
  await cli(["agents-render", "--project", paths.project, "--at", at()]);
  assert.equal((await readFile(paths.agents, "utf8")).includes(`rule:${RULE}`), false, "agents-render renders no pending rule");
  await cli(["rule-resolve", "--project", paths.project, "--section", `rule:${RULE}`, "--action", "overwrite", "--at", at()]).catch(() => null);
  assert.equal((await readFile(paths.agents, "utf8")).includes(`rule:${RULE}`), false, "rule-resolve renders no pending rule");
  assert.equal((await refusal(["rule-propose", "--project", paths.project, "--id", RULE, "--action", "disable", "--order", "2", "--at", at(), "--actor", MODEL])).reasonCode, "CLI_ARGUMENT_MALFORMED");
});

test("527: proposal-approve and proposal-reject run for Atelier only; a model's run appends nothing", async (context) => {
  const paths = await scratch(context);
  const proposed = await proposeGate(paths, "unit");
  const head = (await materializeWorkspace(paths.library)).version;
  await asModel(async () => {
    for (const verb of ["proposal-approve", "proposal-reject"]) {
      const refused = await refusal([verb, "--workspace", paths.library, "--project-id", paths.projectId, "--key", "gate:unit", "--proposed-at", proposed.proposal.proposedAt, "--at", at(), "--actor", OWNER]);
      assert.equal(refused.reasonCode, "MODEL_WRITE_REFUSED", verb);
      assert.deepEqual(refused.details, { target: "gate:unit", remedy: MODEL_WRITE_REMEDY }, verb);
    }
  });
  assert.equal((await materializeWorkspace(paths.library)).version, head);
  assert.deepEqual((await listGateRecords(paths, "pending")).records.map((record) => record.key), ["gate:unit"]);
  // The shipped entry prints the refusal with its target and remedy.
  const run = spawnSync(process.execPath, [ENTRY, "proposal-approve", "--workspace", paths.library, "--key", "gate:unit", "--proposed-at", proposed.proposal.proposedAt, "--at", at(), "--actor", OWNER], {
    encoding: "utf8", env: { ...process.env, EINZBERN_HOME: paths.device, EINZBERN_SURFACE: "" },
  });
  assert.equal(run.status, 1);
  const printed = JSON.parse(run.stderr.trim());
  assert.deepEqual([printed.reasonCode, printed.target, printed.remedy], ["MODEL_WRITE_REFUSED", "gate:unit", MODEL_WRITE_REMEDY]);
});

test("527 GWT2: Atelier's approval declares the gate with the proposal's authorization, and a rule's writes its section", async (context) => {
  const paths = await scratch(context);
  const proposed = await proposeGate(paths, "unit");
  const approved = await asAtelier(() => settle("proposal-approve", paths, "gate:unit", proposed.proposal.proposedAt));
  assert.equal(approved.approved.key, "gate:unit");
  assert.deepEqual((await listGateRecords(paths)).records.map((gate) => gate.name), ["unit"], "the default list holds the approved gate");
  assert.deepEqual((await listGateRecords(paths, "pending")).records, []);
  const state = await materializeWorkspace(paths.library);
  const declared = state.events.at(-2).payload;
  assert.deepEqual([declared.operation, declared.record.collection, declared.record.key], ["config.record.set", "gate", "unit"]);
  assert.deepEqual([declared.surface, declared.decidedIn, declared.decidedInLibraryId], ["atelier", `proposal:gate:unit@${proposed.proposal.proposedAt}`, state.metadata.workspaceId]);

  const rule = await asModel(() => cli(["rule-propose", "--project", paths.project, "--id", RULE, "--at", at(), "--actor", MODEL]));
  const enabled = await asAtelier(() => settle("proposal-approve", paths, `rule:${RULE}`, rule.proposal.proposedAt, ["--project", paths.project]));
  assert.equal(enabled.rule.state, "enabled");
  assert.equal(enabled.written, true);
  assert.match(await readFile(paths.agents, "utf8"), new RegExp(`rule:${RULE}`, "u"));
  const after = await materializeWorkspace(paths.library);
  assert.deepEqual(after.events.slice(-3).map((event) => [event.payload.record.collection, event.payload.decidedIn]), [
    ["rule", `proposal:rule:${RULE}@${rule.proposal.proposedAt}`],
    ["managed-section", `proposal:rule:${RULE}@${rule.proposal.proposedAt}`],
    ["proposal", `proposal:rule:${RULE}@${rule.proposal.proposedAt}`],
  ]);
  assert.equal((await asAtelier(() => refusal(["proposal-approve", "--workspace", paths.library, "--key", "gate:unit", "--proposed-at", "yesterday", "--at", at(), "--actor", OWNER]))).reasonCode, "CLI_ARGUMENT_MALFORMED");
});

test("527 GWT4: a rejected proposal stays readable as rejected, and its approval is PROPOSAL_NOT_PENDING", async (context) => {
  const paths = await scratch(context);
  const proposed = await proposeGate(paths, "unit");
  const rejected = await asAtelier(() => settle("proposal-reject", paths, "gate:unit", proposed.proposal.proposedAt));
  assert.deepEqual([rejected.proposal.status, rejected.proposal.rejectedBy], ["rejected", OWNER]);
  assert.equal((await materializeWorkspace(paths.library)).events.at(-1).payload.surface, "atelier");
  assert.deepEqual((await listGateRecords(paths, "rejected")).records.map((record) => [record.key, record.status]), [["gate:unit", "rejected"]]);
  assert.deepEqual((await listGateRecords(paths, "pending")).records, []);
  const notPending = await asAtelier(() => refusal(["proposal-approve", "--workspace", paths.library, "--project-id", paths.projectId, "--key", "gate:unit", "--proposed-at", proposed.proposal.proposedAt, "--at", at(), "--actor", OWNER]));
  assert.equal(notPending.reasonCode, "PROPOSAL_NOT_PENDING");
  assert.deepEqual((await listGateRecords(paths)).records, []);

  // Proposed again, it is approved only at the instant it was proposed again.
  const again = await proposeGate(paths, "unit", "docs/**");
  const run = spawnSync(process.execPath, [ENTRY, "proposal-approve", "--workspace", paths.library, "--project-id", paths.projectId, "--key", "gate:unit", "--proposed-at", proposed.proposal.proposedAt, "--at", at(), "--actor", OWNER], {
    encoding: "utf8", env: { ...process.env, EINZBERN_HOME: paths.device, EINZBERN_SURFACE: ATELIER_SURFACE },
  });
  const stale = JSON.parse(run.stderr.trim());
  assert.deepEqual([stale.reasonCode, stale.target, stale.required, stale.actual], ["PROPOSAL_STALE", "gate:unit", again.proposal.proposedAt, proposed.proposal.proposedAt]);
  await asAtelier(() => settle("proposal-approve", paths, "gate:unit", again.proposal.proposedAt));
  assert.deepEqual((await listGateRecords(paths)).records.map((gate) => gate.covers), [["docs/**"]]);
});
