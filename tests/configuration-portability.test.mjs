// SPDX-License-Identifier: Apache-2.0
import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { appendEvents, initializeLibrary, materializeWorkspaceFromGenesis } from "../dist/build/packages/core/src/index.js";
import { createWorkspaceSettingRecord, resolveKnowledgeArticlesPath, validateWorkspaceSettingRecord } from "../dist/build/packages/core/src/settings.js";
import { MACHINE_SETTINGS_CATALOG, MACHINE_SETTINGS_VERSION, MACHINE_SETTINGS_LAYER_KIND } from "../dist/build/packages/core/src/machine-settings.js";
import { assertGeneratedArtifactsRoot } from "../dist/build/packages/core/src/artifact-store.js";
import { LEGACY_CONTROL_DIRECTORY } from "../dist/build/packages/core/src/names.js";
import { resolvePortablePath } from "../dist/build/packages/core/src/portable-path.js";

const AT = "2026-10-17T12:00:00Z";
const machineFile = (values) => ({ schemaVersion: MACHINE_SETTINGS_VERSION, layerKind: MACHINE_SETTINGS_LAYER_KIND, updatedAt: AT, values });
const repository = resolve(import.meta.dirname, "..");
async function scratch(t) {
  const root = await mkdtemp(join(tmpdir(), "einzbern-portability-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("portable shared paths reject new absolute writes while validating existing history", async (t) => {
  const root = await scratch(t);
  const library = join(root, "library");
  await initializeLibrary({ root: library, createdAt: AT });
  for (const [key, binding] of [["workspace.generatedArtifactsPath", "paths.artifacts"], ["knowledge.articlesPath", "paths.knowledgeArticles"]]) {
    const absolute = join(root, "external");
    assert.throws(() => createWorkspaceSettingRecord(key, absolute, 1, AT), { reasonCode: "SETTINGS_VALUE_INVALID" });
    const record = createWorkspaceSettingRecord(key, "portable", 1, AT);
    assert.equal(record.value, "portable");
    assert.equal(createWorkspaceSettingRecord(key, `binding:${binding}`, 1, AT).value, `binding:${binding}`);
    assert.equal(validateWorkspaceSettingRecord({ ...record, value: absolute }).value, absolute, "historical absolute declaration still replays");
    assert.equal(resolvePortablePath(root, absolute), absolute);
    assert.equal(resolvePortablePath(root, "portable"), join(root, "portable"));
    await appendEvents(library, [(state) => ({
      payload: { operation: "settings.updated", record: { ...record, value: absolute } },
      projects: state.projects, work: state.work, settings: state.settings,
    })], { occurredAt: AT });
    assert.equal((await materializeWorkspaceFromGenesis(library)).settings.find((entry) => entry.key === key).value, absolute, "existing event history replays without the new-write restriction");
  }
});

test("logical bindings resolve from this device, never from the library; absent bindings fail explicitly", async (t) => {
  const root = await scratch(t);
  const device = join(root, "device");
  await mkdir(device);
  for (const key of ["paths.artifacts", "paths.knowledgeArticles"]) {
    assert.throws(() => resolvePortablePath(root, `binding:${key}`, device), { reasonCode: "PATH_BINDING_UNCONFIGURED" });
  }
  assert.throws(() => resolvePortablePath(root, "binding:unknown", device), { reasonCode: "PATH_BINDING_INVALID" });
  const values = { "paths.artifacts": join(root, "device-artifacts"), "paths.knowledgeArticles": join(root, "device-articles") };
  await writeFile(join(device, "machine-settings.json"), JSON.stringify(machineFile(values)));
  for (const [key, path] of Object.entries(values)) assert.equal(resolvePortablePath(join(root, "library"), `binding:${key}`, device), path);
  for (const [key, path] of Object.entries(values)) {
    assert.equal(resolvePortablePath(root, `binding:${key}/safe/nested.txt`, device), join(path, "safe", "nested.txt"));
    for (const suffix of ["../escape", "safe/../../escape", "/absolute", "safe//empty", "./dot", "safe/", "safe\\escape", "safe:drive", "safe\u0000bad"]) {
      assert.throws(() => resolvePortablePath(root, `binding:${key}/${suffix}`, device), { reasonCode: "PATH_BINDING_INVALID" }, suffix);
    }
  }
  await writeFile(join(device, "machine-settings.json"), JSON.stringify(machineFile({})));
  assert.throws(() => resolvePortablePath(root, "binding:paths.artifacts", device), { reasonCode: "PATH_BINDING_UNCONFIGURED" });
  for (const invalid of [{ values }, { ...machineFile(values), schemaVersion: "unsupported" }, { ...machineFile(values), layerKind: "workspace" }, { ...machineFile(values), updatedAt: "" }]) {
    await writeFile(join(device, "machine-settings.json"), JSON.stringify(invalid));
    assert.throws(() => resolvePortablePath(root, "binding:paths.artifacts", device), { reasonCode: "MACHINE_SETTINGS_FILE_INVALID" });
  }
  await writeFile(join(device, "machine-settings.json"), JSON.stringify(machineFile({ "paths.artifacts": "relative" })));
  assert.throws(() => resolvePortablePath(root, "binding:paths.artifacts", device), { reasonCode: "MACHINE_SETTING_VALUE_INVALID" });
  assert.equal(MACHINE_SETTINGS_CATALOG.find((entry) => entry.key === "execution.maxConcurrentAgents").defaultValue, "8");
});

test("artifact bindings require an existing external directory and refuse the device control home", async (t) => {
  const root = await scratch(t);
  const device = join(root, "device");
  const target = join(root, "external-artifacts");
  await mkdir(device);
  await mkdir(target);
  const previous = process.env.EINZBERN_HOME;
  process.env.EINZBERN_HOME = device;
  try {
    const configure = (path) => writeFile(join(device, "machine-settings.json"), JSON.stringify(machineFile({ "paths.artifacts": path })));
    await configure(target);
    assert.equal(await assertGeneratedArtifactsRoot(join(root, "library"), "binding:paths.artifacts"), await realpath(target));
    const workspace = join(root, "library");
    await mkdir(workspace);
    await configure(workspace);
    await assert.rejects(assertGeneratedArtifactsRoot(workspace, "binding:paths.artifacts"), { reasonCode: "SETTINGS_VALUE_INVALID" });
    const control = join(workspace, LEGACY_CONTROL_DIRECTORY);
    await mkdir(control);
    await writeFile(join(device, "machine-settings.json"), JSON.stringify(machineFile({ "paths.knowledgeArticles": control })));
    assert.throws(() => resolveKnowledgeArticlesPath(workspace, "binding:paths.knowledgeArticles"), { reasonCode: "SETTINGS_VALUE_INVALID" });
    assert.throws(() => resolveKnowledgeArticlesPath(workspace, "binding:paths.knowledgeArticles/nested"), { reasonCode: "SETTINGS_VALUE_INVALID" });
    const absent = join(root, "absent-artifacts");
    await configure(absent);
    await assert.rejects(assertGeneratedArtifactsRoot(join(root, "library"), "binding:paths.artifacts"), { reasonCode: "ARTIFACT_PATH_INVALID" });
    await assert.rejects(access(absent), { code: "ENOENT" }, "external binding must not auto-create a directory");
    await configure(device);
    await assert.rejects(assertGeneratedArtifactsRoot(join(root, "library"), "binding:paths.artifacts"), { reasonCode: "ARTIFACT_PATH_INVALID" });
    const internal = join(device, "artifacts");
    await mkdir(internal);
    await configure(internal);
    await assert.rejects(assertGeneratedArtifactsRoot(join(root, "library"), "binding:paths.artifacts"), { reasonCode: "ARTIFACT_PATH_INVALID" });
  } finally {
    if (previous === undefined) delete process.env.EINZBERN_HOME;
    else process.env.EINZBERN_HOME = previous;
  }
});

test("installed provenance policy is module-relative, independent of an unrelated working directory", async (t) => {
  const root = await scratch(t);
  const installed = join(root, "installed");
  const unrelated = join(root, "unrelated");
  await mkdir(join(installed, "scripts", "policy"), { recursive: true });
  await mkdir(join(unrelated, "scripts", "policy"), { recursive: true });
  await cp(join(repository, "dist", "build"), join(installed, "dist", "build"), { recursive: true });
  const expected = JSON.parse(await readFile(join(repository, "scripts", "policy", "knowledge-provenance.json"), "utf8"));
  await writeFile(join(installed, "scripts", "policy", "knowledge-provenance.json"), JSON.stringify(expected));
  // An unrelated project has its own file, which must not supply this installed engine's policy.
  await writeFile(join(unrelated, "scripts", "policy", "knowledge-provenance.json"), JSON.stringify({ ...expected, relaxedKinds: expected.strictKinds, strictKinds: expected.relaxedKinds }));
  const module = pathToFileURL(join(installed, "dist", "build", "packages", "core", "src", "knowledge-core.js")).href;
  const run = () => spawnSync(process.execPath, ["--input-type=module", "--eval", `const m = await import(${JSON.stringify(module)}); process.stdout.write(JSON.stringify(m.KNOWLEDGE_PROVENANCE_POLICY));`], { cwd: unrelated, encoding: "utf8", env: { ...process.env, EINZBERN_HOME: join(root, "device") } });
  let result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { relaxedKinds: expected.relaxedKinds, strictKinds: expected.strictKinds });
  await rm(join(installed, "scripts", "policy", "knowledge-provenance.json"));
  result = run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /KNOWLEDGE_PROVENANCE_POLICY_UNREADABLE/u, "missing installed asset does not fall back to cwd");
});
