// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-INIT-056 SUB-538: one atomic device store keeps independent host policies and
// records audit provenance while refusing cross-host tiers and malformed escalation state.

import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ENGINE_MODEL_POLICY_WRITE_TARGET,
  EngineModelPolicyError,
  applyEngineModelPolicySet,
  engineModelPolicyCatalogFromSnapshot,
  readEngineModelPolicyCatalog,
  readEngineModelPolicyFile,
  validateEngineModelPolicy,
} from "../dist/build/packages/core/src/engine-model-policy.js";

const ownerDecision = Object.freeze({
  decidedIn: `minutes:${"a".repeat(24)}#D1`,
  libraryId: `library:${"b".repeat(24)}`,
  target: ENGINE_MODEL_POLICY_WRITE_TARGET,
});

function policy(host, model) {
  return {
    categories: [
      { id: "flagship", name: "Flagship", description: "", order: 10 },
      { id: "main", name: "Main", description: "", order: 20 },
      { id: "economy", name: "Economy", description: "", order: 30 },
    ],
    tiers: [
      { order: 10, category: "flagship", runner: host, model, effort: "max", note: "" },
      { order: 20, category: "economy", runner: host, model, effort: "max", note: "" },
    ],
    escalation: { enabled: true, threshold: 2, ceiling: "main" },
  };
}

test("INIT-056 SUB-538: device policy is absent until configured and partitions host rows on write", async (context) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-engine-model-policy-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const home = join(base, "device");

  const empty = await readEngineModelPolicyFile(home);
  assert.deepEqual({ revision: empty.revision, hosts: empty.hosts }, { revision: 0, hosts: {} });
  assert.equal((await readEngineModelPolicyCatalog("codex", home)).selectedStatus, "unconfigured");

  const codex = await applyEngineModelPolicySet({
    home,
    host: "codex",
    policy: policy("codex", "gpt-6-luna"),
    occurredAt: "2026-10-17T01:02:03Z",
    actor: "agent:codex",
    authorization: ownerDecision,
  });
  const claude = await applyEngineModelPolicySet({
    home,
    host: "claude-code",
    policy: policy("claude-code", "claude-opus"),
    occurredAt: "2026-10-17T01:02:04Z",
    actor: "agent:atelier",
    authorization: { ...ownerDecision, decidedIn: `minutes:${"c".repeat(24)}#D2` },
  });

  assert.deepEqual(Object.keys(claude.hosts).sort(), ["claude-code", "codex"]);
  assert.equal(claude.revision, 2);
  assert.equal(claude.hosts.codex.revision, 1);
  assert.equal(claude.hosts.codex.tiers[0].model, "gpt-6-luna");
  assert.equal(claude.hosts["claude-code"].revision, 1);
  assert.equal(claude.hosts["claude-code"].tiers[0].model, "claude-opus");
  assert.equal(codex.revision, 1, "a prior readback remains immutable after another host is written");
  assert.equal((await readEngineModelPolicyCatalog("codex", home)).selectedStatus, "configured");

  const bytes = await readFile(join(home, "engine-model-policy.json"), "utf8");
  assert.equal(JSON.parse(bytes).hosts.codex.digest, claude.hosts.codex.digest);
  assert.equal(claude.hosts.codex.decidedIn, ownerDecision.decidedIn);
  assert.equal(claude.hosts.codex.decidedInLibraryId, ownerDecision.libraryId);
});

test("INIT-056 SUB-538: a legal prototype-named host is unconfigured unless it is an own host entry", async (context) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-engine-model-policy-host-prototype-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const home = join(base, "device");

  const empty = await readEngineModelPolicyCatalog("constructor", home);
  assert.equal(empty.selectedStatus, "unconfigured");
  assert.equal(empty.selectedPolicy, null);

  await applyEngineModelPolicySet({
    home,
    host: "claude-code",
    policy: policy("claude-code", "claude-opus"),
    occurredAt: "2026-10-17T01:03:03Z",
    actor: "agent:atelier",
    authorization: ownerDecision,
  });
  const withAnotherHost = await readEngineModelPolicyCatalog("constructor", home);
  assert.equal(withAnotherHost.selectedStatus, "unconfigured");
  assert.equal(withAnotherHost.selectedPolicy, null);

  await applyEngineModelPolicySet({
    home,
    host: "constructor",
    policy: policy("constructor", "gpt-6-luna"),
    occurredAt: "2026-10-17T01:03:04Z",
    actor: "agent:codex",
    authorization: ownerDecision,
  });
  const configured = await readEngineModelPolicyCatalog("constructor", home);
  assert.equal(configured.selectedStatus, "configured");
  assert.equal(configured.selectedPolicy.tiers[0].runner, "constructor");
  assert.equal(configured.selectedPolicy.tiers[0].model, "gpt-6-luna");
});

test("INIT-056 SUB-538: a delayed same-host write receipt stays bound to its lock-held snapshot", async (context) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-engine-model-policy-snapshot-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const home = join(base, "device");
  const firstDecision = { ...ownerDecision, decidedIn: `minutes:${"a".repeat(24)}#D1` };
  const secondDecision = { ...ownerDecision, decidedIn: `minutes:${"c".repeat(24)}#D2` };

  const firstCommit = await applyEngineModelPolicySet({
    home,
    host: "codex",
    policy: policy("codex", "gpt-6-luna"),
    occurredAt: "2026-10-17T01:04:01Z",
    actor: "agent:first-writer",
    authorization: firstDecision,
  });
  const secondCommit = await applyEngineModelPolicySet({
    home,
    host: "codex",
    policy: policy("codex", "gpt-6-astra"),
    occurredAt: "2026-10-17T01:04:02Z",
    actor: "agent:second-writer",
    authorization: secondDecision,
  });

  // The first CLI can be delayed until after the next same-host writer commits. Its receipt still
  // comes from the file snapshot read under the first write's lock, not from a fresh catalog read.
  const delayedFirstReceipt = engineModelPolicyCatalogFromSnapshot(firstCommit, "codex", home);
  assert.equal(firstCommit.revision, 1);
  assert.equal(delayedFirstReceipt.storeRevision, 1);
  assert.equal(delayedFirstReceipt.selectedPolicy.revision, 1);
  assert.equal(delayedFirstReceipt.selectedPolicy.tiers[0].model, "gpt-6-luna");
  assert.equal(delayedFirstReceipt.selectedPolicy.actor, "agent:first-writer");
  assert.equal(delayedFirstReceipt.selectedPolicy.decidedIn, firstDecision.decidedIn);
  assert.equal(secondCommit.revision, 2);

  const current = await readEngineModelPolicyCatalog("codex", home);
  assert.equal(current.storeRevision, 2);
  assert.equal(current.selectedPolicy.revision, 2);
  assert.equal(current.selectedPolicy.tiers[0].model, "gpt-6-astra");
  assert.equal(current.selectedPolicy.actor, "agent:second-writer");
  assert.equal(current.selectedPolicy.decidedIn, secondDecision.decidedIn);
});

test("INIT-056 SUB-538: policy validation rejects host bleed, unknown ceiling, invalid threshold and missing authorization", async (context) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-engine-model-policy-invalid-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const home = join(base, "device");

  assert.throws(() => validateEngineModelPolicy("codex", policy("claude-code", "gpt-6-luna")), (error) => {
    assert.ok(error instanceof EngineModelPolicyError);
    assert.equal(error.reasonCode, "ENGINE_MODEL_POLICY_INVALID");
    assert.equal(error.details.path, "policy.tiers[0].runner");
    return true;
  });
  assert.throws(() => validateEngineModelPolicy("codex", { ...policy("codex", "gpt-6-luna"), escalation: { enabled: true, threshold: 0, ceiling: "main" } }), /threshold/u);
  assert.throws(() => validateEngineModelPolicy("codex", { ...policy("codex", "gpt-6-luna"), escalation: { enabled: true, threshold: 2, ceiling: "other" } }), /not in this host/u);

  await assert.rejects(applyEngineModelPolicySet({
    home,
    host: "codex",
    policy: policy("codex", "gpt-6-luna"),
    occurredAt: "2026-10-17T01:02:03Z",
    actor: "agent:codex",
    authorization: { ...ownerDecision, target: "models.tiers" },
  }), (error) => error?.reasonCode === "ENGINE_MODEL_POLICY_AUTHORIZATION_REQUIRED");
  assert.equal((await readEngineModelPolicyFile(home)).revision, 0, "refused writes leave no device file state");
});
