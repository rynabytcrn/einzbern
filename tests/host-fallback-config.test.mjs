// SPDX-License-Identifier: Apache-2.0
// S1 fixtures use isolated device directories only; S2 independently runs/accepts these.
import "./helpers/device-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { acquireFileLock } from "../dist/build/packages/core/src/file-lock.js";
import { engineModelPolicyLockPath } from "../dist/build/packages/core/src/device-home.js";
import { join } from "node:path";
import { applyEngineModelPolicySave, applyEngineModelPolicySet, readEngineModelPolicyFile, validateEngineModelPolicyFile, readEngineModelPolicyOperation } from "../dist/build/packages/core/src/engine-model-policy.js";
import { resolveHostExecution } from "../dist/build/packages/core/src/execution-fallback.js";
import { nativeFixture, tuple, at } from "./helpers/host-native-fixture.mjs";
const policy = host => ({ categories: [{ id: "main", name: "Main", order: 10, description: "" }], tiers: [{ ...tuple, runner: host, category: "main", order: 10, note: "retained" }, { ...tuple, runner: host, category: "main", order: 20, note: "unselected" }], escalation: { enabled: true, threshold: 2, ceiling: "main" } });
async function fixture(t) {
  const f = await nativeFixture(t); const authorization = { target: "models.engine-policy", decidedIn: `minutes:${"a".repeat(24)}#D1`, libraryId: f.state.metadata.workspaceId };
  const initial = await applyEngineModelPolicySet({ host: "codex", policy: policy("codex"), home: f.home, occurredAt: at, actor: "agent:fixture", authorization });
  const save = { host: "codex", home: f.home, expectedRevision: initial.hosts.codex.revision, expectedDigest: initial.hosts.codex.digest, operationId: "fixture-save-1", tiers: [{ order: 10, model: "saved-alternative", effort: "high" }], occurredAt: at, actor: "agent:fixture", authorization };
  return { ...f, authorization, initial, save, path: join(f.home, "engine-model-policy.json") };
}
test("T17 precise governed save CAS/readback preserves unselected entries and other-host updates", async t => {
  const f = await fixture(t);
  const other = await applyEngineModelPolicySet({ host: "claude-code", policy: policy("claude-code"), home: f.home, occurredAt: at, actor: "agent:fixture", authorization: f.authorization });
  const saved = await applyEngineModelPolicySave(f.save); assert.equal(saved.status, "committed");
  assert.deepEqual(saved.readback.hosts["claude-code"], other.hosts["claude-code"]);
  assert.deepEqual(saved.operation.result.tiers[1], f.initial.hosts.codex.tiers[1]); assert.equal(saved.operation.result.tiers[0].note, "retained");
  assert.deepEqual(saved.operation.result.categories, f.initial.hosts.codex.categories); assert.deepEqual(saved.operation.result.escalation, f.initial.hosts.codex.escalation);
  assert.equal(saved.operation.result.revision, 2); assert.equal(saved.readback.revision, 3); assert.equal(saved.readback.schemaVersion, "tcrn.engine-model-policy.v2");
  assert.deepEqual(await readEngineModelPolicyFile(f.home), saved.readback);
});
test("T18 same-host conflict preserves bytes; exact replay after lost receipt never increments revision", async t => {
  const f = await fixture(t); const saved = await applyEngineModelPolicySave(f.save); const bytes = await readFile(f.path, "utf8");
  const replay = await applyEngineModelPolicySave({ ...f.save, occurredAt: "2026-10-21T00:00:01Z" }); assert.equal(replay.status, "replayed"); assert.equal(replay.operation.result.revision, 2); assert.equal(await readFile(f.path, "utf8"), bytes);
  await assert.rejects(applyEngineModelPolicySave({ ...f.save, operationId: "new-stale-operation" }), { reasonCode: "ENGINE_MODEL_POLICY_CAS_CONFLICT" }); assert.equal(await readFile(f.path, "utf8"), bytes);
  await assert.rejects(applyEngineModelPolicySave({ ...f.save, tiers: [{ order: 10, model: "different", effort: "max" }] }), { reasonCode: "ENGINE_MODEL_POLICY_OPERATION_CONFLICT" });
  const later = await applyEngineModelPolicySet({ host: "codex", policy: policy("codex"), home: f.home, occurredAt: at, actor: "agent:fixture", authorization: f.authorization });
  const old = await applyEngineModelPolicySave(f.save); assert.equal(old.status, "replayed"); assert.equal(old.operation.result.digest, saved.operation.result.digest); assert.equal(old.readback.hosts.codex.digest, later.hosts.codex.digest); assert.equal(old.readback.hosts.codex.revision, 3);
});
test("T19 recovery is a new revision with CAS, never a rewrite of prior history", async t => {
  const f = await fixture(t); const saved = await applyEngineModelPolicySave(f.save);
  const restored = await applyEngineModelPolicySave({ ...f.save, operationId: "fixture-restore", expectedRevision: saved.operation.result.revision, expectedDigest: saved.operation.result.digest, tiers: [{ order: 10, model: tuple.model, effort: tuple.effort }] });
  assert.equal(restored.operation.result.revision, 3); assert.equal(restored.operation.result.digest, f.initial.hosts.codex.digest); assert.equal(Object.keys(restored.readback.operations).length, 2);
  await assert.rejects(applyEngineModelPolicySave({ ...f.save, operationId: "stale-restore", expectedRevision: saved.operation.result.revision, expectedDigest: saved.operation.result.digest }), { reasonCode: "ENGINE_MODEL_POLICY_CAS_CONFLICT" });
});
test("T21 unauthorized/invalid save leaves current bytes intact; core execution is independent", async t => {
  const f = await fixture(t); const bytes = await readFile(f.path, "utf8");
  await assert.rejects(applyEngineModelPolicySave({ ...f.save, authorization: { ...f.authorization, target: "not-authorized" } }), { reasonCode: "ENGINE_MODEL_POLICY_AUTHORIZATION_REQUIRED" });
  await assert.rejects(applyEngineModelPolicySave({ ...f.save, tiers: [{ order: 999, model: "new", effort: "max" }] }), { reasonCode: "ENGINE_MODEL_POLICY_INVALID" });
  assert.equal(await readFile(f.path, "utf8"), bytes);
  const before = resolveHostExecution(f.request, f.initial, "fixture", at); assert.equal(before.status, "degraded"); assert.equal(before.persistentConfigWrites, 0);
  assert.equal(resolveHostExecution({ ...f.request, saveRequirement: { requiredBeforeExecution: false, status: "failed" } }, f.initial, "fixture", at).status, "degraded");
});
test("explicit first-host policy creation is CAS-bound and replayable, never invented from a tuple", async t => {
  const f = await nativeFixture(t); const authorization = { target: "models.engine-policy", decidedIn: `minutes:${"a".repeat(24)}#D1`, libraryId: f.state.metadata.workspaceId };
  const input = { host: "codex", home: f.home, expectedRevision: 0, expectedDigest: null, operationId: "initial-policy", initialPolicy: policy("codex"), occurredAt: at, actor: "agent:fixture", authorization };
  const first = await applyEngineModelPolicySave(input); assert.equal(first.operation.result.revision, 1); assert.equal((await applyEngineModelPolicySave(input)).status, "replayed");
});

test("T18 competing isolated transactions commit exactly one snapshot and retain the winner", async t => {
  const f = await fixture(t);
  const results = await Promise.allSettled([applyEngineModelPolicySave(f.save), applyEngineModelPolicySave({ ...f.save, operationId: "competing-save", tiers: [{ order: 10, model: "other", effort: "low" }] })]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  const rejected = results.find(result => result.status === "rejected"); assert.equal(rejected.reason.reasonCode, "ENGINE_MODEL_POLICY_CAS_CONFLICT");
  const current = await readEngineModelPolicyFile(f.home); assert.equal(current.hosts.codex.revision, 2); assert.equal(Object.keys(current.operations).length, 1);
});
test("S2 storage compatibility: legacy reads do not migrate bytes and transaction receipts reject malformed history", async t => {
  const f = await fixture(t); const before = await readFile(f.path, "utf8");
  assert.equal((await readEngineModelPolicyFile(f.home)).schemaVersion, "tcrn.engine-model-policy.v1"); assert.equal(await readFile(f.path, "utf8"), before);
  const saved = await applyEngineModelPolicySave(f.save);
  for (const patch of [{ extra: true }, { expectedRevision: 0 }, { storeRevision: 999 }, { result: { ...saved.operation.result, digest: "0".repeat(64) } }]) {
    assert.throws(() => validateEngineModelPolicyFile({ ...saved.readback, operations: { [f.save.operationId]: { ...saved.operation, ...patch } } }));
  }
  assert.throws(() => validateEngineModelPolicyFile({ ...saved.readback, schemaVersion: "tcrn.engine-model-policy.v1" }), "old protocol cannot silently interpret transaction metadata");
});

const injected = code => Object.assign(new Error("deterministic synthetic failure"), { code });
test("T19 pre-atomic permission and disk-full failures retain bytes and report no write", async t => {
  for (const code of ["EACCES", "ENOSPC"]) {
    const f = await fixture(t); const before = await readFile(f.path, "utf8"); let calls = 0;
    await assert.rejects(applyEngineModelPolicySave(f.save, { beforeAtomicWrite: async () => { calls++; throw injected(code); } }), error => error.reasonCode === "ENGINE_MODEL_POLICY_SAVE_FAILED" && error.details.writeOutcome === "not-written" && error.details.causeCode === code);
    assert.equal(calls, 1); assert.equal(await readFile(f.path, "utf8"), before);
    assert.equal((await readEngineModelPolicyOperation(f.save.operationId, f.home)).status, "not-recorded");
  }
});
test("T19 postcommit readback failure and lost return reconcile recorded operation without duplicate write", async t => {
  for (const seam of ["afterCommitBeforeReadback", "afterReadbackBeforeReturn"]) {
    const f = await fixture(t); let prewrites = 0, faultCalls = 0;
    await assert.rejects(applyEngineModelPolicySave(f.save, { beforeAtomicWrite: async () => { prewrites++; }, [seam]: async () => { faultCalls++; throw injected("EIO"); } }), error => error.reasonCode === "ENGINE_MODEL_POLICY_SAVE_RECONCILIATION_REQUIRED" && error.details.writeOutcome === "committed" && error.details.readbackConfirmed === (seam === "afterReadbackBeforeReturn"));
    const receipt = await readEngineModelPolicyOperation(f.save.operationId, f.home);
    assert.equal(receipt.status, "recorded"); assert.equal(receipt.operation.result.revision, 2); assert.equal(receipt.currentHost.digest, receipt.operation.result.digest); assert.equal(prewrites, 1); assert.equal(faultCalls, 1);
    const committed = await readFile(f.path, "utf8");
    const replay = await applyEngineModelPolicySave(f.save, { beforeAtomicWrite: async () => { prewrites++; } });
    assert.equal(replay.status, "replayed"); assert.equal(prewrites, 1); assert.equal(await readFile(f.path, "utf8"), committed);
  }
});
test("T19 bounded save lock timeout preserves existing owner's bytes and makes zero commit", async t => {
  const f = await fixture(t); const lockPath = engineModelPolicyLockPath(f.home); const lock = await acquireFileLock(lockPath);
  try {
    const holder = await readFile(lockPath, "utf8"), policy = await readFile(f.path, "utf8"); let writes = 0;
    await assert.rejects(applyEngineModelPolicySave({ ...f.save, lockTimeoutMs: 0 }, { beforeAtomicWrite: async () => { writes++; } }), { reasonCode: "FILE_LOCK_TIMEOUT" });
    assert.equal(writes, 0); assert.equal(await readFile(lockPath, "utf8"), holder); assert.equal(await readFile(f.path, "utf8"), policy);
  } finally { await lock.release(); }
  assert.equal((await readEngineModelPolicyOperation(f.save.operationId, f.home)).status, "not-recorded");
  assert.equal((await applyEngineModelPolicySave(f.save)).status, "committed");
});

test("S2 failure envelopes do not forward arbitrary exception text or codes", async t => {
  const f = await fixture(t);
  await assert.rejects(applyEngineModelPolicySave(f.save, { afterCommitBeforeReadback: async () => { throw Object.assign(new Error("PRIVATE_CANARY_MESSAGE"), { code: "PRIVATE_CANARY_CODE" }); } }), error => {
    assert.equal(error.details.causeCode, "UNKNOWN"); assert.equal(JSON.stringify(error).includes("PRIVATE_CANARY"), false); assert.equal(error.message.includes("PRIVATE_CANARY"), false); return true;
  });
});
