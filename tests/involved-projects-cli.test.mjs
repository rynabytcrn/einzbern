// SPDX-License-Identifier: Apache-2.0
import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rename, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCli } from "../dist/build/packages/cli/src/index.js";
import { heavyLockDirectoryUnder, usePrivateHeavySlots } from "./helpers/heavy-slots.mjs";
import { initializeLibrary, declareChainIdentity, createProject, createWork, annotateWork, registerLibrary, setConfigRecord, setWorkspaceSetting, readSettingsCatalog, enableRule } from "../dist/build/packages/core/src/index.js";
const at = "2026-10-08T09:00:00Z";
const cli = async args => { let output = ""; await runCli(args, { write: text => { output += text; } }); return JSON.parse(output); };

test("existing gates consumers execute independent roots from a Cross Project work reference and retain per-target refusal", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "involved-consumers-")));
  const previous = process.env.EINZBERN_HOME;
  process.env.EINZBERN_HOME = join(root, "device");
  t.after(async () => { process.env.EINZBERN_HOME = previous; await rm(root, { recursive: true, force: true }); });
  // TCRN-CROSS-SUB-502 (STORY-538 GWT5): the gates-run below takes its heavy-run slot under root, never a run's around the test.
  usePrivateHeavySlots(t, heavyLockDirectoryUnder(root));
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

// INIT-053 U10 (approved contract items 6, 7, 9): the output, rules and AGENTS consumers apply each
// target's own configuration, through the existing consumers and nothing new. Each resolved target
// carries one handoff (project-chain.ts); the gate process receives exactly it, with the repository
// and root it runs in, which is the object a native host dispatch passes for that target. A missing
// and an unavailable target are results of their own and stop no other target.
test("U10: output, rules and AGENTS consumers follow each target's own configuration; missing and unavailable targets keep results of their own", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "involved-u10-")));
  const previous = process.env.EINZBERN_HOME;
  process.env.EINZBERN_HOME = join(root, "device");
  t.after(async () => { process.env.EINZBERN_HOME = previous; await rm(root, { recursive: true, force: true }); });
  // TCRN-CROSS-SUB-502 (STORY-538 GWT5): the gates-run below takes its heavy-run slot under root, never a run's around the test.
  usePrivateHeavySlots(t, heavyLockDirectoryUnder(root));
  async function make(name, role, coordinationLibraryId) {
    const path = join(root, name + "-library"), repo = join(root, name);
    await mkdir(repo);
    const initial = await initializeLibrary({ root: path, createdAt: at });
    await declareChainIdentity(path, { role, coordinationLibraryId: coordinationLibraryId ?? initial.metadata.workspaceId }, { occurredAt: at });
    const state = await createProject(path, { externalKey: name, name: "Equal name", occurredAt: at });
    const reference = { libraryId: state.metadata.workspaceId, projectId: state.projects[0].id };
    await registerLibrary({ projectPath: repo, libraryPath: path, projectId: reference.projectId, registeredAt: at, gitRemote: null });
    return { path, repo, reference };
  }
  const c = await make("coordination", "coordination");
  const targets = {};
  for (const [name, language] of [["alpha", "en"], ["beta", "fr"], ["gamma", "ja"]]) {
    const target = await make(name, "project", c.reference.libraryId);
    const projectId = target.reference.projectId;
    await setWorkspaceSetting(target.path, { key: "artifact.language", value: language, configurationProjectId: projectId, occurredAt: at });
    await setWorkspaceSetting(target.path, { key: "knowledge.articlesPath", value: `${name}-articles`, configurationProjectId: projectId, occurredAt: at });
    await setConfigRecord(target.path, { collection: "variable", key: "target.note", projectId, value: { type: "string", value: name, description: "The target" }, occurredAt: at });
    await setConfigRecord(target.path, { collection: "gate", key: name, projectId, value: { root: ".", command: [process.execPath, "-e", "require('node:fs').writeFileSync('handoff.json',process.env.EINZBERN_PROJECT_CONTEXT)"], covers: ["**"], enabled: true, required: true, releaseOnly: false }, occurredAt: at });
    targets[name] = target;
  }
  // One rule, enabled for alpha alone.
  await enableRule({ libraryRoot: targets.alpha.path, projectRoot: targets.alpha.repo, configurationProjectId: targets.alpha.reference.projectId, id: "autonomy", occurredAt: at });
  const missing = { libraryId: "library:" + "e".repeat(24), projectId: "project:" + "f".repeat(24) };
  const created = await createWork(c.path, { projectId: c.reference.projectId, externalKey: "FOUR", kind: "Initiative", parentId: null, involvedProjects: { state: "selected", targets: [targets.alpha.reference, targets.beta.reference, targets.gamma.reference, missing] }, occurredAt: at });
  const id = created.work[0].id;
  await rename(targets.gamma.path, `${targets.gamma.path}-away`);

  // The output and rules consumers read each target's own handoff.
  const resolved = await cli(["work-project-context", "--workspace", c.path, "--id", id]);
  const byLibrary = new Map(resolved.contexts.map(entry => [entry.reference.libraryId, entry]));
  const alpha = byLibrary.get(targets.alpha.reference.libraryId).handoff;
  const beta = byLibrary.get(targets.beta.reference.libraryId).handoff;
  assert.deepEqual([alpha.output.language, alpha.output.knowledgeArticlesPath, beta.output.language, beta.output.knowledgeArticlesPath], ["en", "alpha-articles", "fr", "beta-articles"]);
  assert.deepEqual([alpha.rules.map(rule => rule.id), beta.rules], [["autonomy"], []]);
  assert.deepEqual([alpha, beta].map(handoff => handoff.variables.map(variable => [variable.key, variable.value.value])), [[["target.note", "alpha"]], [["target.note", "beta"]]]);
  assert.deepEqual([alpha.reference, alpha.workRevision, alpha.writeAuthority, alpha.libraryPath], [targets.alpha.reference, 1, "not-granted", targets.alpha.path]);
  assert.ok(resolved.conflicts.includes("artifact.language"), "differing values are reported, never one applied to all");
  assert.deepEqual([byLibrary.get(missing.libraryId).status, byLibrary.get(missing.libraryId).handoff], ["unregistered", null]);
  assert.deepEqual([byLibrary.get(targets.gamma.reference.libraryId).status, byLibrary.get(targets.gamma.reference.libraryId).handoff], ["unavailable", null]);
  assert.equal(resolved.developmentReady, false);

  // The gate consumer: alpha and beta run with their own handoff; gamma and the missing reference are
  // refused as results of their own, and stop neither.
  const planned = await cli(["gates-plan", "--workspace", c.path, "--work-id", id, "--release", "true"]);
  assert.deepEqual(planned.targets.map(result => [result.reference.libraryId, result.ok, result.readiness === null]).sort(),
    [[targets.alpha.reference.libraryId, true, false], [targets.beta.reference.libraryId, true, false], [targets.gamma.reference.libraryId, false, true], [missing.libraryId, false, true]].sort());
  const run = await cli(["gates-run", "--workspace", c.path, "--work-id", id, "--release", "true", "--at", at]);
  assert.equal(run.ok, false);
  const results = new Map(run.targets.map(result => [result.reference.libraryId, result]));
  assert.deepEqual([targets.alpha, targets.beta].map(target => results.get(target.reference.libraryId).ok), [true, true]);
  for (const reference of [targets.gamma.reference, missing]) assert.deepEqual([results.get(reference.libraryId).ok, results.get(reference.libraryId).reasonCode], [false, "PROJECT_GATE_CONFIGURATION_UNAVAILABLE"]);
  for (const [name, handoff] of [["alpha", alpha], ["beta", beta]]) {
    const { repository, projectRoot, ...received } = JSON.parse(await readFile(join(targets[name].repo, "handoff.json"), "utf8"));
    assert.deepEqual([repository, projectRoot], [null, targets[name].repo]);
    assert.deepEqual(received, handoff, `${name}: the gate process received the target's own handoff`);
  }

  // The AGENTS consumer: agents-render on each handoff's registered repository renders that target's
  // own rule sections; the unavailable target's repository is refused on its own.
  for (const handoff of [alpha, beta]) assert.equal((await cli(["agents-render", "--project", handoff.repositories[0].projectPath, "--at", at])).reasonCode, "AGENTS_RENDERED");
  assert.match(await readFile(join(targets.alpha.repo, "AGENTS.md"), "utf8"), /einzbern:section id=rule:autonomy /u);
  assert.doesNotMatch(await readFile(join(targets.beta.repo, "AGENTS.md"), "utf8"), /id=rule:autonomy/u);
  await assert.rejects(cli(["agents-render", "--project", targets.gamma.repo, "--at", at]), error => typeof error.reasonCode === "string");
  assert.match(await readFile(join(targets.alpha.repo, "AGENTS.md"), "utf8"), /einzbern:section id=rule:autonomy /u, "the refusal left the other target's output as it was");
});
