// SPDX-License-Identifier: Apache-2.0
import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { initializeLibrary, createProject, createWork, setWorkspaceSetting } from "../dist/build/packages/core/src/index.js";
import { runCli } from "../dist/build/packages/cli/src/index.js";
import { resetRecallCache } from "../dist/build/packages/core/src/recall.js";

async function prepareFixture({ execute, reject = false, role = "coordination", noRun = false }) {
  const source = await readFile(new URL("../packages/cli/src/index.ts", import.meta.url), "utf8");
  const start = source.indexOf("async function prepareGates(");
  const end = source.indexOf("\ntype GatesLibrary", start);
  assert.ok(start >= 0 && end > start);
  const js = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  const calls = [];
  const state = { metadata: { workspaceId: "fixture" }, work: [] };
  const prepare = runInNewContext(`${js}\nprepareGates`, {
    validateWorkspace: async () => state,
    chainIdentity: () => ({ role }),
    HEAVY_SLOT_VARIABLE: "EINZBERN_HEAVY_SLOT",
    acquireHeavySlot: async () => { calls.push("acquire"); return { token: "fixture-token", path: "/fixture/slot", release: () => calls.push("release") }; },
    workGateTargets: async (_state, _values, run, executeRun) => {
      calls.push("prepare");
      if (run && role === "coordination" && !noRun) {
        await executeRun({}, { env: { EINZBERN_PROJECT_CONTEXT: "fixture-context" } });
        await executeRun({}, {});
      }
      return role === "coordination" ? { ok: true } : null;
    },
    runGates: async (_plan, options) => {
      if (options.env !== undefined) {
        assert.equal(options.env.EINZBERN_HEAVY_SLOT, "fixture-token:/fixture/slot");
        assert.equal(options.env.EINZBERN_PROJECT_CONTEXT, "fixture-context");
      }
      calls.push("execute");
      if (reject) throw new Error("fixture refusal");
      return {};
    },
    effectiveProjectState: async () => state,
    listValue: () => [], listGates: () => [], booleanValue: () => false,
    gatesProjectRoot: async () => "/fixture", planGates: async () => ({ planned: true }),
    gateSubjects: () => [], workSubjectKeys: () => [],
  });
  return { calls, invoke: () => prepare({ workspace: "/fixture", "work-id": "fixture" }, execute) };
}

test("coordination gate preparation holds a heavy slot through execution", async () => {
  const { calls, invoke } = await prepareFixture({ execute: true });
  await invoke();
  assert.deepEqual(calls, ["prepare", "acquire", "execute", "execute", "release"]);
});
test("coordination gate preparation releases its slot on refusal", async () => {
  const { calls, invoke } = await prepareFixture({ execute: true, reject: true });
  await assert.rejects(invoke, /fixture refusal/u);
  assert.deepEqual(calls, ["prepare", "acquire", "execute", "release"]);
});
test("read-only, single-project and no-op coordination preparation do not take an execution slot", async () => {
  for (const options of [{ execute: false }, { execute: true, role: "project" }, { execute: true, noRun: true }]) {
    const { calls, invoke } = await prepareFixture(options);
    await invoke();
    assert.deepEqual(calls, ["prepare"]);
  }
});

test("in-process recall keeps project-specific corpus settings independent", async (context) => {
  const base = await mkdtemp(join(tmpdir(), "einzbern-recall-project-audit-"));
  const previous = process.env.EINZBERN_HOME;
  process.env.EINZBERN_HOME = join(base, "device");
  context.after(async () => {
    resetRecallCache();
    if (previous === undefined) delete process.env.EINZBERN_HOME;
    else process.env.EINZBERN_HOME = previous;
    await rm(base, { recursive: true, force: true });
  });
  const root = join(base, "library");
  const at = "2026-10-01T00:00:00Z";
  await initializeLibrary({ root, createdAt: at });
  const ids = [];
  for (const key of ["RECALL-A", "RECALL-B"]) {
    const state = await createProject(root, { occurredAt: at, externalKey: key, name: key });
    ids.push(state.projects.find(project => project.externalKey === key).id);
  }
  await createWork(root, { occurredAt: at, projectId: ids[0], externalKey: "RECALL-INIT", kind: "Initiative", parentId: null, title: "Koala habitat", scope: "A long habitat scope with more detail than the small excerpt allows." });
  for (const [id, limit] of [[ids[0], 8], [ids[1], 64]]) await setWorkspaceSetting(root, { occurredAt: at, configurationProjectId: id, key: "retrieval.scopeExcerptBytes", value: String(limit) });
  async function read(id) {
    let output = "";
    await runCli(["recall", "--workspace", root, "--project-id", id, "--at", at, "--query", "RECALL-INIT"], { write: value => { output += value; } });
    return JSON.parse(output);
  }
  const small = await read(ids[0]);
  const large = await read(ids[1]);
  resetRecallCache();
  const freshLarge = await read(ids[1]);
  assert.equal(large.scopeExcerptBytes, 64);
  assert.deepEqual(large.records, freshLarge.records);
  assert.notEqual(small.records[0].summary, large.records[0].summary);
  assert.equal((await read(ids[1])).rebuilt, false);
});

async function integrationFunction(name, globals) {
  const source = await readFile(new URL("../packages/cli/src/index.ts", import.meta.url), "utf8");
  const parsed = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true);
  const declaration = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(declaration, `${name} is a module-level function`);
  const js = ts.transpileModule(declaration.getText().replaceAll("import.meta.url", "moduleUrl"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  return runInNewContext(`${js}\n${name}`, globals);
}

test("INIT062 running identity source seam binds actual bundle layout and two stable content reads", async () => {
  // Source seam fixture, not an actual packaged-CLI or E4 acceptance receipt.
  const { basename, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const calls = [];
  const globals = {
    moduleUrl: "file:///fixture/package/scripts/einzbern.mjs", fileURLToPath, basename, dirname, join,
    realpath: async path => path, readFile: async () => JSON.stringify({ schemaVersion: "einzbern.release-manifest.v1", version: "3.1.0" }),
    FRAMEWORK_VERSION: "3.1.0", DOT_AGENTS_TEMPLATE_VERSION: "dot-template-fixture", BUILT_IN_RULES: [{ id: "fixture", version: 1 }],
    computeInstallTreeDigest: async root => { calls.push(["hash", root]); return { schemaVersion: "einzbern.install-tree-digest.v1", sha256: "a".repeat(64), entries: [{ path: "scripts/einzbern.mjs" }] }; },
    verifyInstallTree: async (root, digest) => { calls.push(["readback", root, digest]); return { ok: true, actual: digest }; },
    readEngineCurrent: async () => ({ version: "3.1.0" }), engineVersionDirectory: () => "/fixture/package",
    fail: (reasonCode, message) => { throw Object.assign(new Error(message), { reasonCode }); },
  };
  const read = await integrationFunction("configBackupRunningVersion", globals);
  const identity = await read();
  assert.equal(identity.artifactIdentity.kind, "observed-artifact-identity");
  assert.equal(identity.engineCommit, null); assert.equal(identity.engineCommitStatus, "unknown");
  assert.deepEqual(calls, [["hash", "/fixture/package"], ["readback", "/fixture/package", "a".repeat(64)]]);
  for (const change of [
    { moduleUrl: "file:///fixture/dist/build/packages/cli/src/index.js" },
    { readFile: async () => JSON.stringify({ schemaVersion: "einzbern.release-manifest.v1", version: "9.9.9" }) },
    { verifyInstallTree: async () => ({ ok: false, actual: "b".repeat(64) }) },
    { readFile: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); }, readEngineCurrent: async () => null },
  ]) await assert.rejects((await integrationFunction("configBackupRunningVersion", { ...globals, ...change }))(), error => error.reasonCode === "CONFIG_BACKUP_ENGINE_IDENTITY_UNAVAILABLE");
  const installed = await integrationFunction("configBackupRunningVersion", { ...globals, readFile: async () => { throw Object.assign(new Error("manifest is not installed"), { code: "ENOENT" }); } });
  assert.equal((await installed()).artifactIdentity.sha256, "a".repeat(64));
});

test("INIT062 policy approval invokes existing Owner-decision authority with exact policy and actual device scope", async () => {
  const { canonicalSha256 } = await import("../dist/build/packages/protocol/src/index.js");
  const source = { libraryRoot: "/fixture/library", projectRef: { libraryId: "fixture-library", projectId: "fixture-project" } };
  const request = { reservedRoot: "/fixture/reserve", policy: {}, binding: { backupGroupId: "group", writerBindingRef: "writer", executionEnvironmentRef: "device:fixture-device" } };
  const calls = [];
  const globals = {
    configBackupRunningVersion: () => {}, configBackupSource: () => {}, configBackupProtectedRoots: () => {},
    validateConfigBackupRetentionPolicy: () => ({ status: "policy-valid", policyDigest: "a".repeat(64), policy: { approvalEvidenceRef: "minutes:fixture#D1" } }),
    readDevice: async () => ({ deviceId: "fixture-device" }), canonicalSha256: value => canonicalSha256(JSON.parse(JSON.stringify(value))), materializeWorkspace: async () => ({ fixture: true }),
    verifyWriteAuthorization: async input => { calls.push(input); return {}; },
  };
  const context = (await integrationFunction("configBackupContext", globals))();
  assert.equal((await context.approvePolicy(request, source, {})).approved, true);
  const scope = canonicalSha256({ projectRef: source.projectRef, backupGroupId: "group", reservedRoot: "/fixture/reserve", writerBindingRef: "writer", executionEnvironmentRef: "device:fixture-device" });
  assert.equal(calls[0].target, `config-backup-policy:${"a".repeat(64)}:${scope}`);
  assert.equal(calls[0].decidedIn, "minutes:fixture#D1");
  assert.equal(await context.approvePolicy({ ...request, binding: { ...request.binding, executionEnvironmentRef: "device:other" } }, source, {}), null);
  const denied = (await integrationFunction("configBackupContext", { ...globals, verifyWriteAuthorization: async () => { throw Object.assign(new Error("not Owner-authorized"), { reasonCode: "MODEL_WRITE_AUTHORIZATION_INVALID" }); } }))();
  assert.equal(await denied.approvePolicy(request, source, {}), null);
});
