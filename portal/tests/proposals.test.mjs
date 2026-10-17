// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-527 GWT2 and GWT4, the interface's part (MIN-257 D6, Q5; TCRN-CROSS-SUB-479). A gate or
// rule change a model proposed through the CLI shows on Atelier's gates or rules page as a proposal,
// apart from the declarations. Approving it from Atelier is the write itself: the gate list then holds
// the gate (the rule list the enabled rule) and the proposals are gone, and the events record surface
// atelier and decidedIn proposal:<key>@<proposedAt>. Rejecting it keeps it, rejected, and the page
// shows a rejected proposal read only, without an Approve button. Every library, project, device and
// home directory here is a temporary one.

import "../../tests/helpers/device-home.mjs";
import { portalFixture } from "./helpers/portal-fixture.mjs";
import { execFile } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";

const execFileAsync = promisify(execFile);
const portalRoot = fileURLToPath(new URL("..", import.meta.url));
const CLI = process.env.TCRN_WORKFLOW_CLI ?? join(portalRoot, "..", "scripts", "einzbern.mjs");
// Atelier starts only with TCRN_PORTAL_ACTOR set (TCRN-CROSS-SUB-454); this is the test's value.
const TEST_ACTOR = "agent:test-portal-proposals";
const MODEL = "agent:test-proposing-model";
// The portal is a loopback server on this machine; the offline boundary allows the page's requests to
// it, made as the page makes them, through the platform's request function.
const loopback = globalThis.fetch;

let second = 0;
const at = () => {
  second += 1;
  return new Date(Date.UTC(2026, 9, 14, 13, 0, second)).toISOString().replace(".000Z", "Z");
};

/** The CLI as a model's shell runs it: no EINZBERN_SURFACE. */
async function cli(args, env = {}) {
  const { EINZBERN_SURFACE: _surface, ...inherited } = process.env;
  const { stdout } = await execFileAsync(process.execPath, [CLI, ...args], { encoding: "utf8", maxBuffer: 32e6, env: { ...inherited, ...env } });
  return JSON.parse(stdout);
}

/** A registered project with its library, a scratch HOME and a device directory. */
async function scratch(t) {
  const { base, start } = await portalFixture(t, "tcrn-portal-proposals-");
  const home = join(base, "home");
  await mkdir(home, { recursive: true });
  const deviceEnv = { EINZBERN_HOME: join(base, "device", "einzbern") };
  const proseRoot = join(base, "project");
  await mkdir(proseRoot, { recursive: true });
  const workspace = join(proseRoot, ".ether");
  await cli(["init", "--workspace", workspace, "--project-name", "PORTAL-PROPOSALS", "--at", at()], deviceEnv);
  const created = await cli(["project-create", "--workspace", workspace, "--external-key", "PORTAL-PROPOSALS-PROJECT", "--name", "PORTAL-PROPOSALS", "--at", at()], deviceEnv);
  await cli(["library-register", "--project", proseRoot, "--library", workspace, "--project-id", created.record.id, "--at", at()], deviceEnv);
  return { base, home, deviceEnv, proseRoot, workspace, projectId: created.record.id, start };
}

async function startPortal(fixture) {
  const listening = await fixture.start([join(portalRoot, "portal.mjs"), "--library", fixture.workspace, "--port", "0"], {
    env: { ...process.env, TCRN_WORKFLOW_CLI: CLI, TCRN_PORTAL_ACTOR: TEST_ACTOR, ...fixture.deviceEnv, HOME: fixture.home },
  });
  const page = await (await loopback(listening.url)).text();
  const boot = JSON.parse(page.match(/const BOOT = (\{.*\});/u)[1]);
  const target = { epoch: boot.epoch, libraryId: boot.library.libraryId, projectId: Object.hasOwn(boot.library, "configurationProjectId") ? boot.library.configurationProjectId : boot.library.projectId ?? null };
  const call = async (path, method = "GET", body = undefined) => {
    const headers = { "x-portal-token": boot.token, ...(method === "GET" ? {} : { "content-type": "application/json", "x-configuration-target": JSON.stringify(target) }) };
    const response = await loopback(new URL(path, listening.url), { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  return { call };
}

/** The page's own renderer of the proposals, taken from index.html and run with the English copy. */
async function proposalsRenderer() {
  const source = await readFile(join(portalRoot, "index.html"), "utf8");
  const block = source.match(/\n {2}\/\/ Proposals \(TCRN-CROSS-STORY-527\) begin\.\n([\s\S]*?)\n {2}\/\/ Proposals end\./u)?.[1];
  assert.ok(block, "the page renders its proposals in one marked block");
  const sandbox = {};
  new Function("window", await readFile(join(portalRoot, "locales.js"), "utf8"))(sandbox);
  const english = sandbox.PORTAL_LOCALES.en;
  const t = (key, values = {}) => Object.entries(values).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), english[key] ?? key);
  const esc = (value) => String(value).replace(/[&<>"']/gu, (character) => `&#${character.charCodeAt(0)};`);
  return new Function("t", "esc", "ruleTitle", "state", `${block}\nreturn proposalsMarkup;`)(t, esc, (id) => id, { locale: "en" });
}

const lastEvents = async (fixture, count) => {
  const { total } = await cli(["event-list", "--workspace", fixture.workspace, "--limit", "1"], fixture.deviceEnv);
  return (await cli(["event-list", "--workspace", fixture.workspace, "--offset", String(total - count)], fixture.deviceEnv)).records.map((record) => record.payload);
};

const proposeGate = (fixture, name) => cli(["gates-config-propose", "--workspace", fixture.workspace, "--project-id", fixture.projectId, "--at", at(), "--name", name, "--command", JSON.stringify(["node", "--version"]), "--covers", "src/**", "--actor", MODEL], fixture.deviceEnv);

test("527 GWT2: Atelier's approval of a proposed gate is the write; the gate list then holds it and the proposals are empty", async (t) => {
  const fixture = await scratch(t);
  const proposed = await proposeGate(fixture, "unit");
  const { call } = await startPortal(fixture);
  const before = await call("/api/gates");
  assert.equal(before.status, 200, JSON.stringify(before.body));
  assert.deepEqual(before.body.gates, [], "a proposal is not a declaration");
  assert.deepEqual(before.body.proposals.map((proposal) => [proposal.key, proposal.status, proposal.proposedBy]), [["gate:unit", "pending", MODEL]]);

  const invalid = await call(`/api/proposals/${encodeURIComponent("gate:unit")}`, "POST", { action: "merge", proposedAt: proposed.proposal.proposedAt });
  assert.deepEqual([invalid.status, invalid.body.reasonCode], [400, "PORTAL_PROPOSAL_INPUT_INVALID"]);

  const approved = await call(`/api/proposals/${encodeURIComponent("gate:unit")}`, "POST", { action: "approve", proposedAt: proposed.proposal.proposedAt });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.deepEqual(approved.body.gates.map((gate) => gate.name), ["unit"]);
  assert.deepEqual(approved.body.proposals, [], "the proposals area is empty after the approval");
  const after = await call("/api/gates");
  assert.deepEqual([after.body.gates.map((gate) => gate.name), after.body.proposals], [["unit"], []]);
  const [declared, settled] = await lastEvents(fixture, 2);
  const authorization = ["atelier", `proposal:gate:unit@${proposed.proposal.proposedAt}`];
  assert.deepEqual([declared.operation, declared.record.collection, declared.record.key, declared.surface, declared.decidedIn], ["config.record.set", "gate", "unit", ...authorization]);
  assert.deepEqual([settled.operation, settled.record.collection, settled.surface, settled.decidedIn], ["config.record.removed", "proposal", ...authorization]);
});

test("527 GWT4: a rejected proposal stays on the page read only, without an Approve button, and its approval is refused", async (t) => {
  const fixture = await scratch(t);
  const proposed = await proposeGate(fixture, "unit");
  const { call } = await startPortal(fixture);
  const rejected = await call(`/api/proposals/${encodeURIComponent("gate:unit")}`, "POST", { action: "reject", proposedAt: proposed.proposal.proposedAt });
  assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
  assert.deepEqual(rejected.body.proposals.map((proposal) => [proposal.key, proposal.status, proposal.rejectedBy]), [["gate:unit", "rejected", TEST_ACTOR]]);
  assert.deepEqual(rejected.body.gates, []);
  const [event] = await lastEvents(fixture, 1);
  assert.deepEqual([event.operation, event.record.collection, event.record.value.status, event.surface], ["config.record.set", "proposal", "rejected", "atelier"]);

  const refused = await call(`/api/proposals/${encodeURIComponent("gate:unit")}`, "POST", { action: "approve", proposedAt: proposed.proposal.proposedAt });
  assert.deepEqual([refused.status, refused.body.ok, refused.body.reasonCode], [409, false, "PROPOSAL_NOT_PENDING"]);

  // The page's renderer: the rejected row is read only; a pending one carries Approve and Reject.
  const render = await proposalsRenderer();
  const shown = (await call("/api/gates")).body.proposals;
  const rejectedMarkup = render(shown, "gate");
  assert.match(rejectedMarkup, /data-proposal-status="rejected"/u);
  assert.match(rejectedMarkup, /data-proposal-state="rejected">Rejected</u);
  assert.doesNotMatch(rejectedMarkup, /data-proposal-action=/u, "a rejected proposal has no Approve or Reject button");
  assert.match(rejectedMarkup, new RegExp(`Rejected by ${TEST_ACTOR}`, "u"));
  const again = await proposeGate(fixture, "unit");
  const pendingMarkup = render((await call("/api/gates")).body.proposals, "gate");
  assert.match(pendingMarkup, new RegExp(`data-proposal-action="approve" data-proposal-key="gate:unit" data-proposed-at="${again.proposal.proposedAt}"`, "u"));
  assert.match(pendingMarkup, /data-proposal-action="reject"/u);
  assert.equal(render([], "gate"), "", "no proposals, no area");
  assert.equal(render(shown, "rule"), "", "a page shows its own kind only");
});

test("527 GWT2: Atelier's approval of a proposed rule enables it and writes its section; the rules page keeps proposals apart from pending sections", async (t) => {
  const fixture = await scratch(t);
  const rule = "autonomy";
  const proposed = await cli(["rule-propose", "--project", fixture.proseRoot, "--id", rule, "--at", at(), "--actor", MODEL], fixture.deviceEnv);
  const { call } = await startPortal(fixture);
  const before = await call("/api/rules");
  assert.equal(before.status, 200, JSON.stringify(before.body));
  assert.equal(before.body.rules.find((entry) => entry.id === rule).state, "disabled");
  assert.deepEqual(before.body.pending, [], "no managed section waits");
  assert.deepEqual(before.body.proposals.map((proposal) => [proposal.key, proposal.status]), [[`rule:${rule}`, "pending"]]);

  const approved = await call(`/api/proposals/${encodeURIComponent(`rule:${rule}`)}`, "POST", { action: "approve", proposedAt: proposed.proposal.proposedAt });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal(approved.body.rules.find((entry) => entry.id === rule).state, "enabled");
  assert.deepEqual(approved.body.proposals, []);
  assert.match(await readFile(join(fixture.proseRoot, "AGENTS.md"), "utf8"), new RegExp(`rule:${rule}`, "u"));
  const events = await lastEvents(fixture, 3);
  assert.deepEqual(events.map((payload) => [payload.record.collection, payload.surface, payload.decidedIn]), ["rule", "managed-section", "proposal"].map((collection) => [collection, "atelier", `proposal:rule:${rule}@${proposed.proposal.proposedAt}`]));
});
