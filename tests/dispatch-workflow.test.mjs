// SPDX-License-Identifier: Apache-2.0
import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCli } from "../dist/build/packages/cli/src/index.js";
import { initializeLibrary, createProject, createWork, declareChainIdentity, registerLibrary, setConfigRecord, setWorkspaceSetting, applyEngineModelPolicySet, materializeWorkspace } from "../dist/build/packages/core/src/index.js";
import { prepareDispatch, recordDispatch, writeDispatchArtifact, PROCESS_RETURN_VERSION } from "../dist/build/packages/core/src/dispatch-workflow.js";
import { dispatchAdmissionDigest } from "../dist/build/packages/core/src/dispatch-evidence.js";
import { DEFAULT_ENGINE_QUOTA_POLICY } from "../dist/build/packages/core/src/execution-policy.js";
const at = "2026-10-18T12:00:00Z";
const tuple = { runner: "codex", model: "fixture-explicit", effort: "max" };
const selectors = { host: "codex", category: "main", rejections: 0, requestedAgents: 1 };
async function invoke(args) {
  let stdout = "";
  try { await runCli(args, { write: text => { stdout += text; } }); return { ok: true, stdout, result: JSON.parse(stdout) }; }
  catch (error) { return { ok: false, stdout, code: error.reasonCode ?? error.code, result: stdout ? JSON.parse(stdout) : null }; }
}
async function fixture(t, quota = false) {
  const root = await mkdtemp(join(tmpdir(), "einzbern-dispatch-machine-"));
  const previous = process.env.EINZBERN_HOME;
  const home = join(root, "device"); process.env.EINZBERN_HOME = home;
  t.after(async () => { process.env.EINZBERN_HOME = previous; await rm(root, { recursive: true, force: true }); });
  async function library(name, role, coordinationId) {
    const path = join(root, name); const initial = await initializeLibrary({ root: path, createdAt: at });
    await declareChainIdentity(path, { role, coordinationLibraryId: coordinationId ?? initial.metadata.workspaceId }, { occurredAt: at });
    const state = await createProject(path, { externalKey: name, name, occurredAt: at });
    const projectId = state.projects[0].id; const repo = join(root, name + "-repo"); await mkdir(repo);
    const remote = `https://example.test/${name}`;
    await registerLibrary({ projectPath: repo, libraryPath: path, projectId, registeredAt: at, gitRemote: remote }, home);
    if (role === "project") {
      await setWorkspaceSetting(path, { key: "artifact.language", value: "en", configurationProjectId: projectId, occurredAt: at });
      await setConfigRecord(path, { collection: "chain", key: "repositories", projectId, value: { bindings: [{ id: name, name, repository: remote, buildService: "fixture", buildProject: name }] }, occurredAt: at });
    }
    return { path, reference: { libraryId: state.metadata.workspaceId, projectId } };
  }
  const coordination = await library("coordination", "coordination");
  const a = await library("alpha", "project", coordination.reference.libraryId);
  const b = await library("beta", "project", coordination.reference.libraryId);
  await applyEngineModelPolicySet({ home, host: "codex", occurredAt: at, actor: "agent:fixture", authorization: { target: "models.engine-policy", decidedIn: `minutes:${"a".repeat(24)}#D1`, libraryId: coordination.reference.libraryId },
    policy: { categories: [{ id: "main", name: "Main", order: 10, description: "" }], tiers: [{ ...tuple, category: "main", order: 10, note: "" }], escalation: { enabled: true, threshold: 2, ceiling: "main" }, ...(quota ? { quota: DEFAULT_ENGINE_QUOTA_POLICY } : {}) } });
  const state = await createWork(coordination.path, { projectId: coordination.reference.projectId, externalKey: "DISPATCH", kind: "Initiative", parentId: null, title: "Fixture", involvedProjects: { state: "selected", targets: [a.reference, b.reference] }, occurredAt: at });
  return { root, home, coordination, a, b, state, id: state.work[0].id };
}
const observations = () => ({ availableCombinations: [tuple] });
const raw = (prepared, target = 0, extra = {}) => ({ schemaVersion: PROCESS_RETURN_VERSION, source: "native-host-return", bindingDigest: prepared.bindings[target].digest, selectedTuple: structuredClone(tuple), startedAt: new Date().toISOString(), stdout: "actual fixture output\n", stderr: "", exitCode: 0, ...extra });
const save = (path, value) => writeFile(path, JSON.stringify(value));
async function treeBytes(root) {
  const result = {};
  async function visit(path, key) { for (const entry of await readdir(path, { withFileTypes: true })) { const child = join(path, entry.name); const name = key + "/" + entry.name; if (entry.isDirectory()) await visit(child, name); else result[name] = await readFile(child, "hex"); } }
  await visit(root, ""); return result;
}

test("machine prepare CLI binds all real fixture targets, record derives every duplicate, legacy remains read-only", async t => {
  const f = await fixture(t);
  // Warm ordinary read caches before snapshotting; evidence workflow must not mutate library events or device policy.
  await prepareDispatch(f.state, f.id, selectors, observations(), f.home);
  const before = await treeBytes(f.coordination.path); const policy = await readFile(join(f.home, "engine-model-policy.json"), "utf8");
  const input = join(f.root, "observations.json"); await save(input, observations());
  const bindingPath = join(f.root, "preparation.json");
  const args = ["execution-prepare", "--workspace", f.coordination.path, "--id", f.id, "--host", "codex", "--category", "main", "--rejections", "0", "--requested-agents", "1", "--observations", input, "--output", bindingPath];
  const prepared = await invoke(args); assert.equal(prepared.ok, true, prepared.stdout);
  assert.deepEqual(prepared.result.selectors, selectors); assert.deepEqual(prepared.result.observations, observations());
  assert.equal(prepared.result.bindings.length, 2); assert.equal(prepared.result.context.dispatchAdmitted, true);
  assert.deepEqual(JSON.parse(await readFile(bindingPath, "utf8")), prepared.result);
  for (const binding of prepared.result.bindings) {
    assert.deepEqual(binding.handoff, prepared.result.context.contexts[binding.target].handoff);
    const processPath = join(f.root, `process-${binding.target}.json`); const processReturn = raw(prepared.result, binding.target); await save(processPath, processReturn);
    const output = join(f.root, `record-${binding.target}.json`);
    const record = await invoke(["execution-record", "--binding", bindingPath, "--target", String(binding.target), "--process-return", processPath, "--output", output]);
    assert.equal(record.ok, true, record.stdout); assert.deepEqual(record.result.raw, processReturn);
    const result = record.result.normalized.evidence.hostResult; const admission = binding.handoff.executionAdmission;
    assert.equal(result.workId, f.id); assert.equal(result.workRevision, binding.handoff.workRevision);
    assert.deepEqual(result.projectReference, binding.handoff.reference); assert.deepEqual(result.request, admission.request);
    assert.deepEqual(result.selectedTuple, tuple); assert.equal(result.policyDigest, admission.policy.digest); assert.equal(result.policyRevision, admission.policy.revision);
    assert.equal(result.admissionDigest, dispatchAdmissionDigest(admission));
    assert.equal(record.result.normalized.verification, "caller-supplied-host-return-not-independently-authenticated");
    const legacy = join(f.root, `legacy-${binding.target}.json`); await save(legacy, record.result.normalized.evidence);
    const legacyBytes = await readFile(legacy, "utf8"); const checked = await invoke(["execution-evidence", "--from-file", legacy]);
    assert.equal(checked.ok, true); assert.equal(await readFile(legacy, "utf8"), legacyBytes);
  }
  assert.equal((await invoke(args)).code, "EEXIST");
  assert.deepEqual(await treeBytes(f.coordination.path), before); assert.equal(await readFile(join(f.home, "engine-model-policy.json"), "utf8"), policy);
  if (process.platform !== "win32") assert.equal((await stat(bindingPath)).mode & 0o777, 0o600);
});

test("missing, mismatched and stale machine observations refuse without manufacturing capabilities or timestamps", async t => {
  const f = await fixture(t, true);
  for (const [input, reason] of [
    [{}, "EXECUTION_CAPABILITIES_MISSING"],
    [{ availableCombinations: [{ ...tuple, effort: "low" }] }, "EXECUTION_COMBINATION_UNSUPPORTED"],
    [{ ...observations(), usage: { observedAt: "2020-01-01T00:00:00Z", source: "fixture-old", fiveHourUsedPercent: 0, weeklyUsedPercent: 0 } }, "EXECUTION_USAGE_STALE"],
    [{ ...observations(), expectedPolicy: { revision: 99, digest: "a".repeat(64) } }, "EXECUTION_POLICY_STALE"],
  ]) {
    const obs = join(f.root, reason + ".json"); await save(obs, input); const output = join(f.root, reason + "-saved.json");
    const result = await invoke(["execution-prepare", "--workspace", f.coordination.path, "--id", f.id, "--host", "codex", "--category", "main", "--rejections", "0", "--requested-agents", "1", "--observations", obs, "--output", output]);
    assert.equal(result.code, "DISPATCH_PREPARATION_REFUSED");
    assert.equal(result.result.context.dispatchAdmitted, false); assert.equal(result.result.bindings.length, 2);
    assert.ok(result.result.bindings[0].handoff.executionAdmission.reasons.includes(reason));
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")), result.result);
    if (input.usage) assert.equal(result.result.bindings[0].handoff.executionAdmission.quota.observedAt, input.usage.observedAt);
    assert.equal(recordDispatch(result.result, 0, raw(result.result)).normalized.valid, false);
  }
});

test("record CLI retains failed/missing/invalid returns, rejects mismatched target and modified saved binding", async t => {
  const f = await fixture(t); const prepared = await prepareDispatch(f.state, f.id, selectors, observations(), f.home);
  const bindingPath = join(f.root, "binding.json"); await save(bindingPath, prepared);
  const cases = [
    [raw(prepared, 0, { exitCode: 17 }), "DISPATCH_PROCESS_FAILED"],
    [(({ stdout, ...rest }) => rest)(raw(prepared)), "DISPATCH_EVIDENCE_UNAVAILABLE"],
    [(({ stderr, exitCode, ...rest }) => rest)(raw(prepared)), "DISPATCH_EVIDENCE_UNAVAILABLE"],
    [raw(prepared, 1), "DISPATCH_EVIDENCE_INVALID"],
    [raw(prepared, 0, { selectedTuple: { ...tuple, model: "wrong-model" } }), "DISPATCH_EVIDENCE_INVALID"],
    [raw(prepared, 0, { selectedTuple: { ...tuple, runner: "wrong-runner" } }), "DISPATCH_EVIDENCE_INVALID"],
    [raw(prepared, 0, { selectedTuple: { ...tuple, effort: "low" } }), "DISPATCH_EVIDENCE_INVALID"],
    [(({ selectedTuple, ...rest }) => rest)(raw(prepared)), "DISPATCH_EVIDENCE_INVALID"],
    [raw(prepared, 0, { exitCode: "0" }), "DISPATCH_EVIDENCE_INVALID"],
    [raw(prepared, 0, { source: "node-test-case-summary" }), "DISPATCH_EVIDENCE_INVALID"],
    [raw(prepared, 0, { startedAt: "2020-01-01T00:00:00Z" }), "DISPATCH_EVIDENCE_INVALID"],
    [{ status: "completed" }, "DISPATCH_EVIDENCE_INVALID"],
  ];
  for (const [index, [input, code]] of cases.entries()) {
    const processPath = join(f.root, `raw-${index}.json`); await save(processPath, input); const output = join(f.root, `result-${index}.json`);
    const result = await invoke(["execution-record", "--binding", bindingPath, "--target", "0", "--process-return", processPath, "--output", output]);
    assert.equal(result.code, code, result.stdout); assert.deepEqual(result.result.raw, input);
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")), result.result);
    assert.equal((await invoke(["execution-record", "--binding", bindingPath, "--target", "0", "--process-return", processPath, "--output", output])).code, "EEXIST");
  }
  for (const field of ["workId", "workRevision", "reference", "executionAdmission"]) {
    const changed = structuredClone(prepared); changed.bindings[0].handoff[field] = null;
    assert.equal(recordDispatch(changed, 0, raw(prepared)).normalized.valid, false);
  }
  assert.equal(recordDispatch(prepared, 999, raw(prepared)).normalized.valid, false);
  const missing = recordDispatch(prepared, 0, { ...raw(prepared), stdout: undefined });
  assert.equal(missing.normalized.valid, false, "present malformed streams never become empty strings");
});

test("private create-new persistence refuses device/library roots and preserves occupied outputs", async t => {
  const f = await fixture(t); const value = { fixture: true };
  for (const root of [f.home, f.coordination.path, f.a.path, f.b.path]) {
    await assert.rejects(writeDispatchArtifact(join(root, "must-not-write.json"), value, [], f.home), /outside device and library roots/);
    assert.equal((await readdir(root)).includes("must-not-write.json"), false);
  }
  const unregistered = join(f.root, "unregistered");
  await initializeLibrary({ root: unregistered, createdAt: at });
  await assert.rejects(writeDispatchArtifact(join(unregistered, "must-not-write.json"), value, [], f.home), /outside device and library roots/);
  const occupied = join(f.root, "occupied.json"); await writeFile(occupied, "keep exactly");
  await assert.rejects(writeDispatchArtifact(occupied, value, [], f.home), { code: "EEXIST" });
  assert.equal(await readFile(occupied, "utf8"), "keep exactly");
  const state = await materializeWorkspace(f.coordination.path); assert.equal(state.work.length, 1);
});

test("unresolved targets remain in preparation, while malformed selectors/observations cannot claim admission", async t => {
  const f = await fixture(t);
  const unresolved = { libraryId: `library:${"e".repeat(24)}`, projectId: `project:${"f".repeat(24)}` };
  const state = await createWork(f.coordination.path, { projectId: f.coordination.reference.projectId, externalKey: "MISSING-TARGET", kind: "Initiative", parentId: null, title: "Unresolved", involvedProjects: { state: "selected", targets: [f.a.reference, unresolved] }, occurredAt: at });
  const id = state.work.find(item => item.externalKey === "MISSING-TARGET").id;
  const prepared = await prepareDispatch(state, id, selectors, observations(), f.home);
  assert.equal(prepared.context.dispatchAdmitted, false); assert.equal(prepared.bindings.length, 2);
  const missing = prepared.context.contexts.findIndex(context => context.reference.libraryId === unresolved.libraryId);
  assert.equal(prepared.bindings[missing].handoff, null);
  assert.equal(recordDispatch(prepared, missing, raw(prepared, missing)).normalized.valid, false);
  await assert.rejects(prepareDispatch(f.state, f.id, selectors, { host: "other", ...observations() }, f.home), /only availableCombinations/);
  await assert.rejects(prepareDispatch(f.state, f.id, { ...selectors, requestedAgents: 0 }, observations(), f.home));
});

test("record checks actual start freshness without rewriting admission or old quota time", async t => {
  const f = await fixture(t, true);
  const usage = { observedAt: new Date().toISOString(), source: "fixture-original", fiveHourUsedPercent: 1.5, weeklyUsedPercent: 2.5 };
  const prepared = await prepareDispatch(f.state, f.id, selectors, { ...observations(), usage }, f.home);
  assert.equal(prepared.context.dispatchAdmitted, true);
  const fresh = recordDispatch(prepared, 0, raw(prepared)); assert.equal(fresh.normalized.complete, true);
  // Synthetic old preparation tests elapsed start validation, not a refreshed production receipt.
  const old = structuredClone(prepared); const admission = old.bindings[0].handoff.executionAdmission;
  admission.evaluatedAt = "2020-01-01T00:00:00Z"; admission.quota.observedAt = "2020-01-01T00:00:00Z";
  old.bindings[0].digest = dispatchAdmissionDigest(old.bindings[0].handoff);
  old.context.contexts[0].handoff = structuredClone(old.bindings[0].handoff);
  const { digest, ...payload } = old; old.digest = dispatchAdmissionDigest(payload);
  const rejected = recordDispatch(old, 0, raw(old));
  assert.equal(rejected.normalized.valid, false); assert.match(rejected.normalized.problems.join(";"), /five minutes|stale/);
  assert.equal(rejected.normalized.evidence.handoff.executionAdmission.quota.observedAt, "2020-01-01T00:00:00Z");
  const bindTimes = (evaluatedAt, observedAt) => {
    const copy = structuredClone(prepared);
    const selected = copy.bindings[0].handoff.executionAdmission;
    selected.evaluatedAt = evaluatedAt;
    selected.quota.observedAt = observedAt;
    selected.quota.ageMs = Date.parse(evaluatedAt) - Date.parse(observedAt);
    copy.bindings[0].digest = dispatchAdmissionDigest(copy.bindings[0].handoff);
    copy.context.contexts[0].handoff = structuredClone(copy.bindings[0].handoff);
    const { digest: ignored, ...contents } = copy;
    copy.digest = dispatchAdmissionDigest(contents);
    return copy;
  };
  const now = Date.now();
  const expiry = bindTimes(new Date(now - 2_000).toISOString(), new Date(now - 301_000).toISOString());
  const expired = recordDispatch(expiry, 0, raw(expiry, 0, { startedAt: new Date(now).toISOString() }));
  assert.equal(expired.normalized.valid, false);
  assert.deepEqual(expired.normalized.problems, ["quota observation was stale at the actual process start"]);
  const future = recordDispatch(prepared, 0, raw(prepared, 0, { startedAt: new Date(now + 60_000).toISOString() }));
  assert.equal(future.normalized.valid, false);
  assert.match(future.normalized.problems.join(";"), /in the future/);
  const completedLongAgo = bindTimes("2020-01-01T00:00:00Z", "2020-01-01T00:00:00Z");
  const timely = recordDispatch(completedLongAgo, 0, raw(completedLongAgo, 0, { startedAt: "2020-01-01T00:00:01Z" }));
  assert.equal(timely.normalized.complete, true, "late recording does not invalidate a timely actual start");
});
