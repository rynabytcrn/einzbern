// SPDX-License-Identifier: Apache-2.0
import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCli } from "../dist/build/packages/cli/src/index.js";
import { initializeLibrary, declareChainIdentity, createProject, createWork, annotateWork, registerLibrary, setConfigRecord, setWorkspaceSetting, readSettingsCatalog } from "../dist/build/packages/core/src/index.js";
const at = "2026-10-08T09:00:00Z";
const cli = async args => { let output = ""; await runCli(args, { write: text => { output += text; } }); return JSON.parse(output); };

test("existing gates consumers execute independent roots from a Cross Project work reference and retain per-target refusal", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "involved-consumers-")));
  const previous = process.env.EINZBERN_HOME;
  process.env.EINZBERN_HOME = join(root, "device");
  t.after(async () => { process.env.EINZBERN_HOME = previous; await rm(root, { recursive: true, force: true }); });
  async function make(name, role, coordinationLibraryId) {
    const path = join(root, name + "-library"), repo = join(root, name);
    await mkdir(repo);
    const initial = await initializeLibrary({ root: path, createdAt: at });
    await declareChainIdentity(path, { role, coordinationLibraryId: coordinationLibraryId ?? initial.metadata.workspaceId }, { occurredAt: at });
    const state = await createProject(path, { externalKey: name, name: "Equal name", occurredAt: at });
    const reference = { libraryId: state.metadata.workspaceId, projectId: state.projects[0].id };
    await registerLibrary({ projectPath: repo, libraryPath: path, projectId: reference.projectId, registeredAt: at, gitRemote: `https://example.test/${name === "alpha" ? "en" : "fr"}` });
    return { path, repo, reference };
  }
  const c = await make("coordination", "coordination");
  const a = await make("alpha", "project", c.reference.libraryId);
  const b = await make("beta", "project", c.reference.libraryId);
  for (const [target, language] of [[a, "en"], [b, "fr"]]) {
    await setWorkspaceSetting(target.path, { key: "artifact.language", value: language, configurationProjectId: target.reference.projectId, occurredAt: at });
    const catalog = readSettingsCatalog(target.reference.libraryId, []);
    const tiers = JSON.parse(catalog.settings.find(s => s.key === "models.tiers").currentValue).map(tier => ({ ...tier, model: `${language}-model`, effort: "medium" }));
    await setWorkspaceSetting(target.path, { key: "models.tiers", value: JSON.stringify(tiers), configurationProjectId: target.reference.projectId, occurredAt: at });
    for (const [key, value] of Object.entries({ "design.authority": `https://${language}.example.test`, "design.repository": `https://example.test/${language}`, "design.pullRequestTarget": "main", "design.productionDocs": `https://${language}.example.test/docs`, "design.buildService": "test", "design.buildProject": language, "design.consumedVersion": "1.0.0" })) await setWorkspaceSetting(target.path, { key, value, configurationProjectId: target.reference.projectId, occurredAt: at });
    await setConfigRecord(target.path, { collection: "chain", key: "repositories", projectId: target.reference.projectId, value: { bindings: [{ id: language, name: language, repository: `https://example.test/${language}`, buildService: "test", buildProject: language }] }, occurredAt: at });
    await setConfigRecord(target.path, { collection: "gate", key: language, projectId: target.reference.projectId, value: { root: ".", command: [process.execPath, "-e", "const c=JSON.parse(process.env.EINZBERN_PROJECT_CONTEXT);require('node:fs').writeFileSync('result.txt',c.settings.find(s=>s.key==='artifact.language').value);require('node:fs').writeFileSync('handoff.json',JSON.stringify(c))"], covers: ["**"], enabled: true, required: true, releaseOnly: false }, occurredAt: at });
  }
  const state = await createWork(c.path, { projectId: c.reference.projectId, externalKey: "BOTH", kind: "Initiative", parentId: null, involvedProjects: { state: "selected", targets: [a.reference, b.reference] }, occurredAt: at });
  const id = state.work[0].id;
  const args = ["--workspace", c.path, "--work-id", id, "--release", "true"];
  const plan = await cli(["gates-plan", ...args]);
  assert.equal(plan.targets.length, 2);
  assert.deepEqual(new Set(plan.targets.map(x => x.plan.projectRoot)), new Set([a.repo, b.repo]));
  const run = await cli(["gates-run", ...args, "--at", at]);
  assert.equal(run.ok, true);
  assert.equal(await readFile(join(a.repo, "result.txt"), "utf8"), "en");
  assert.equal(await readFile(join(b.repo, "result.txt"), "utf8"), "fr");
  assert.equal(JSON.parse(await readFile(join(a.repo, "handoff.json"), "utf8")).repositoryBindings.bindings[0].buildProject, "en");
  assert.equal(JSON.parse(await readFile(join(b.repo, "handoff.json"), "utf8")).repositoryBindings.bindings[0].buildProject, "fr");
  for (const result of run.targets) {
    assert.equal(result.handoff.reference.libraryId, result.reference.libraryId);
    assert.equal(result.handoff.writeAuthority, "not-granted");
    const language = result.handoff.settings.find(s => s.key === "artifact.language").value;
    assert.ok(JSON.parse(result.handoff.settings.find(s => s.key === "models.tiers").value).every(tier => tier.model === `${language}-model`));
    assert.equal(result.handoff.readiness.development.ready, true);
    assert.equal(result.handoff.design.bindings.find(binding => binding.key === "design.buildProject").value, language);
    assert.ok(result.recordPath.includes(result.reference.libraryId.replace(":", "-")));
  }
  const helperRepo = join(root, "alpha-helper"); await mkdir(helperRepo);
  await registerLibrary({ projectPath: helperRepo, libraryPath: a.path, projectId: a.reference.projectId, registeredAt: at, gitRemote: "https://example.test/en-helper" });
  await setConfigRecord(a.path, { collection: "chain", key: "repositories", projectId: a.reference.projectId, value: { bindings: [
    { id: "engine", name: "Engine", repository: "https://example.test/en", buildService: "test", buildProject: "en" },
    { id: "helper", name: "Helper", repository: "https://example.test/en-helper", buildService: "test", buildProject: "helper" },
  ] }, occurredAt: at });
  const bothRepositories = await cli(["gates-run", ...args, "--at", at]);
  assert.equal(bothRepositories.targets.length, 3);
  const productRuns = bothRepositories.targets.filter(result => result.reference.libraryId === a.reference.libraryId);
  assert.equal(new Set(productRuns.map(result => result.recordPath)).size, 2);
  assert.equal(JSON.parse(await readFile(join(helperRepo, "handoff.json"), "utf8")).repository.buildProject, "helper");
  const denied = join(b.repo, "not-executable"); await writeFile(denied, "#!/bin/sh\nexit 0\n", { mode: 0o600 });
  await setConfigRecord(b.path, { collection: "gate", key: "fr", projectId: b.reference.projectId, value: { root: ".", command: [denied], covers: ["**"], enabled: true, required: true, releaseOnly: false }, occurredAt: at });
  const refused = await cli(["gates-run", ...args, "--at", at]);
  assert.equal(refused.ok, false);
  assert.equal(refused.targets.find(x => x.reference.libraryId === a.reference.libraryId).ok, true);
  assert.equal(refused.targets.find(x => x.reference.libraryId === b.reference.libraryId).ok, false);
  await annotateWork(c.path, { id, involvedProjects: { state: "undecided", targets: [] }, occurredAt: at });
  assert.equal((await cli(["gates-plan", ...args])).ok, false);
  await annotateWork(c.path, { id, involvedProjects: { state: "coordination-only", targets: [] }, occurredAt: at });
  assert.equal((await cli(["gates-plan", ...args])).targets[0].status, "coordination-only");
});
