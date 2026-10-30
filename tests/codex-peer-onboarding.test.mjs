// SPDX-License-Identifier: Apache-2.0
// Pure policy and temporary-device fixtures; these do not establish host wake capability.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ENGINE_MODEL_POLICY_WRITE_TARGET, applyEngineModelPolicySet, codexPeerReadiness,
  engineModelPolicyOnboarding, readEngineModelPolicyCatalog, readEngineModelPolicyFile,
  resolveEngineExecutionPolicyFromSnapshot,
} from "../dist/build/packages/core/src/engine-model-policy.js";

function readyPolicy(host = "codex") {
  const draft = engineModelPolicyOnboarding(host);
  return { ...draft, tiers: draft.tiers.map(row => row.category === "flagship" ? row : { ...row, model: `fixture-${row.category}`, effort: "medium" }) };
}
const authorization = { decidedIn: `minutes:${"a".repeat(24)}#D1`, libraryId: `library:${"b".repeat(24)}`, target: ENGINE_MODEL_POLICY_WRITE_TARGET };

test("fresh onboarding offers all three categories without pretending empty model groups are ready", () => {
  const draft = engineModelPolicyOnboarding("codex");
  assert.deepEqual(draft.categories.map(row => row.id), ["flagship", "main", "economy"]);
  assert.deepEqual(draft.tiers.map(({ category, runner, model, effort }) => ({ category, runner, model, effort })),
    ["flagship", "main", "economy"].map(category => ({ category, runner: "codex", model: "", effort: "" })));
  assert.deepEqual(codexPeerReadiness("codex", draft), { applicable: true, ready: false, missingCategories: ["main", "economy"], invalidCeiling: null });
  assert.deepEqual(codexPeerReadiness("codex"), codexPeerReadiness("codex", draft));
  assert.deepEqual(engineModelPolicyOnboarding("codex", draft), draft, "repeat onboarding is idempotent");
});

test("main and economy are required; flagship binding is optional but cannot be an empty enabled ceiling", () => {
  const configured = readyPolicy();
  assert.equal(codexPeerReadiness("codex", configured).ready, true);
  for (const category of ["main", "economy"]) {
    for (const field of ["model", "effort"]) {
      const missing = { ...configured, tiers: configured.tiers.map(row => row.category === category ? { ...row, [field]: "" } : row) };
      assert.deepEqual(codexPeerReadiness("codex", missing).missingCategories, [category]);
      assert.equal(codexPeerReadiness("codex", missing).ready, false);
    }
  }
  const escalation = { enabled: true, threshold: 2, ceiling: "flagship" };
  assert.deepEqual(codexPeerReadiness("codex", { ...configured, escalation }), { applicable: true, ready: false, missingCategories: [], invalidCeiling: "flagship" });
  assert.equal(codexPeerReadiness("codex", { ...configured, escalation: { ...escalation, ceiling: "main" } }).ready, true);
});

test("onboarding preserves custom categories, all user tier groups and escalation while adding only gaps", () => {
  const existing = {
    categories: [{ id: "custom", name: "Owner category", description: "keep exact", order: 7 }, { id: "main", name: "Owner main", description: "custom main", order: 17 }],
    tiers: [{ category: "custom", runner: "codex", model: "owner-custom", effort: "low", order: 5, note: "preserve" }, { category: "main", runner: "codex", model: "owner-main", effort: "high", order: 15, note: "preserve too" }],
    escalation: { enabled: true, threshold: 4, ceiling: "main" },
  };
  const before = structuredClone(existing);
  const draft = engineModelPolicyOnboarding("codex", existing);
  assert.deepEqual(existing, before);
  for (const row of existing.categories) assert.deepEqual(draft.categories.find(candidate => candidate.id === row.id), row);
  for (const row of existing.tiers) assert.deepEqual(draft.tiers.find(candidate => candidate.order === row.order), row);
  assert.deepEqual(draft.escalation, existing.escalation);
  assert.deepEqual(draft.categories.map(row => row.id).sort(), ["custom", "economy", "flagship", "main"]);
  assert.deepEqual(engineModelPolicyOnboarding("codex", draft), draft);
  assert.deepEqual(codexPeerReadiness("codex", draft).missingCategories, ["economy"]);
});

test("only explicit codex policy is applicable; neither unknown nor another host activates peer mode", () => {
  for (const host of ["unknown", "constructor", "dot", "chatgpt-dot", "claude-code", "dsh"]) {
    assert.deepEqual(codexPeerReadiness(host, readyPolicy(host)), { applicable: false, ready: false, missingCategories: [], invalidCeiling: null });
    assert.ok(engineModelPolicyOnboarding(host).tiers.every(row => row.runner === host));
  }
});

test("catalog onboarding is read-only; supported saves preserve other hosts and truthful provenance", async t => {
  const home = await mkdtemp(join(tmpdir(), "peer-onboarding-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const empty = await readEngineModelPolicyCatalog("codex", home);
  assert.equal(empty.selectedStatus, "unconfigured");
  assert.equal(empty.peerReadiness.ready, false);
  assert.deepEqual(empty.onboarding, engineModelPolicyOnboarding("codex"));
  assert.equal((await readEngineModelPolicyFile(home)).revision, 0);
  await assert.rejects(readFile(join(home, "engine-model-policy.json")), { code: "ENOENT" });
  const write = (host, policy) => applyEngineModelPolicySet({ home, host, policy, actor: "agent:fixture", occurredAt: "2026-10-30T00:00:00Z", authorization });
  const claude = await write("claude-code", readyPolicy("claude-code"));
  const codex = await write("codex", readyPolicy());
  assert.deepEqual(codex.hosts["claude-code"], claude.hosts["claude-code"]);
  assert.equal(codex.hosts.codex.decidedIn, authorization.decidedIn);
  assert.equal((await readEngineModelPolicyCatalog("codex", home)).peerReadiness.ready, true);
  const bytes = await readFile(join(home, "engine-model-policy.json"), "utf8");
  const catalog = await readEngineModelPolicyCatalog("codex", home);
  assert.deepEqual(catalog.onboarding.tiers, codex.hosts.codex.tiers);
  assert.equal(await readFile(join(home, "engine-model-policy.json"), "utf8"), bytes);
  const unavailable = await write("codex", { ...readyPolicy(), escalation: { enabled: true, threshold: 2, ceiling: "flagship" } });
  assert.throws(() => resolveEngineExecutionPolicyFromSnapshot(unavailable, { host: "codex", category: "economy", rejections: 0, home }), error => error.reasonCode === "ENGINE_MODEL_POLICY_INVALID" && error.details.path === "models.escalation.ceiling");
});

test("readiness follows the resolver's actual base and ceiling rows, not any convenient usable tier", () => {
  const configured = readyPolicy();
  const emptyBase = { ...configured, tiers: [...configured.tiers, { category: "economy", runner: "codex", model: "", effort: "", order: 100, note: "owner deferred base" }] };
  assert.deepEqual(codexPeerReadiness("codex", emptyBase).missingCategories, ["economy"]);
  const emptyCeiling = {
    ...configured,
    tiers: [{ category: "main", runner: "codex", model: "", effort: "", order: 1, note: "owner deferred ceiling" }, ...configured.tiers],
    escalation: { enabled: true, threshold: 2, ceiling: "main" },
  };
  assert.deepEqual(codexPeerReadiness("codex", emptyCeiling), { applicable: true, ready: false, missingCategories: [], invalidCeiling: "main" });
});
