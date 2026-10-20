// SPDX-License-Identifier: Apache-2.0
// Tests in this file run sequentially; Node isolates each file in a process.
import { CLI, R46_AT, R47_COORDINATION_KEYS, TEST_ACTOR, appendHistoricalAttestationEnable, asDevice, assert, cli, execFileAsync, join, managedSection, mkdtemp, portalRoot, readBoot, readFile, readOptions, realpath, registeredLibrary, request, rm, scratch, startPortal, test, tmpdir, unregisterLibrary, writeFile, writeOptions } from './portal-support.mjs';


test("INIT-056 SUB-539: Atelier model-policy API reads the engine source and writes only with Owner authorization", async (t) => {
  const fixture = await scratch("tcrn-portal-model-policy-", "TCRN-PORTAL-MODEL-POLICY");
  const { child, url } = await startPortal(fixture);
  t.after(async () => { child.kill(); await rm(fixture.base, { recursive: true, force: true }); });
  const { boot, page } = await readBoot(url);
  assert.match(page, /data-page="engine-model-policy"/u, "Atelier exposes the engine-owned policy as a visible page");
  assert.match(page, /data-engine-model-policy-host/u, "the visible policy page selects an engine host before reading or writing");
  assert.match(page, /data-engine-model-policy-save/u, "the visible policy page uses the governed engine-policy write action");
  const policy = {
    categories: [
      { id: "flagship", name: "Flagship", description: "", order: 10 },
      { id: "main", name: "Main", description: "", order: 20 },
      { id: "economy", name: "Economy", description: "", order: 30 },
    ],
    tiers: [
      { order: 10, category: "flagship", runner: "codex", model: "gpt-6-luna", effort: "max", note: "" },
      { order: 20, category: "economy", runner: "codex", model: "gpt-6-luna", effort: "max", note: "" },
    ],
    escalation: { enabled: true, threshold: 2, ceiling: "main" },
  };
  const initial = await request(url, "/api/model-policy?host=codex", readOptions(boot.token));
  assert.equal(initial.response.status, 200);
  assert.equal(initial.body.selectedStatus, "unconfigured");

  const writeScope = { libraryId: boot.library.libraryId, libraryPath: boot.library.libraryPath };
  const wrong = await request(url, "/api/model-policy", writeOptions(boot.token, "POST", { host: "codex", policy, decidedIn: `minutes:${"d".repeat(24)}#D1`, ...writeScope }));
  assert.equal(wrong.response.status, 409);
  assert.equal(wrong.body.reasonCode, "MODEL_WRITE_AUTHORIZATION_INVALID");

  const meeting = await cli([
    "minutes-record", "--workspace", fixture.workspace, "--at", "2026-10-17T03:00:00Z", "--project-id", fixture.projectId,
    "--external-key", "PORTAL-MODEL-POLICY-OWNER-DECISION", "--title", "Engine model policy",
    "--summary", "Owner authorizes the engine model policy write.", "--decisions", "Set models.engine-policy for Codex.",
    "--decided-by", "owner:governance", "--actor", TEST_ACTOR,
  ], fixture.deviceEnv);
  const minutesId = meeting.id;
  const saved = await request(url, "/api/model-policy", writeOptions(boot.token, "POST", { host: "codex", policy, decidedIn: `${minutesId}#D1`, ...writeScope }));
  assert.equal(saved.response.status, 200);
  assert.equal(saved.body.reasonCode, "ENGINE_MODEL_POLICY_WRITE_COMMITTED");
  assert.equal(saved.body.readback.selectedHost, "codex");
  assert.equal(saved.body.readback.selectedPolicy.tiers[0].model, "gpt-6-luna");
});


test("reconciliation includes custom variable names as well as registered settings", async (t) => {
  const fixture = await scratch("tcrn-portal-conservation-reconcile-", "TCRN-PORTAL-CONSERVATION-RECONCILE");
  await cli(["variable-set", "--workspace", fixture.workspace, "--at", new Date().toISOString(), "--actor", "agent:test", "--name", "deploy.host", "--type", "string", "--value", "build.example.com"], { ...fixture.deviceEnv, EINZBERN_SURFACE: "atelier" });
  const { child, url } = await startPortal(fixture);
  t.after(async () => { child.kill(); await rm(fixture.base, { recursive: true, force: true }); });
  const { boot } = await readBoot(url);
  const greenText = "# AGENTS.md\n\nSet retrieval.tau and deploy.host before close.\n";
  await writeFile(join(fixture.proseRoot, "AGENTS.md"), greenText, "utf8");
  const green = await request(url, "/api/agents-md/reconcile", readOptions(boot.token));
  assert.equal(green.body.ok, true);
  assert.equal(green.body.findings.length, 0);
  assert.ok(green.body.rows.some((row) => row.key === "retrieval.tau" && row.registered));
  assert.ok(green.body.rows.some((row) => row.key === "deploy.host" && row.registered), "custom variable names participate in reconciliation");
  await writeFile(join(fixture.proseRoot, "AGENTS.md"), `${greenText}\nAlso set retrieval.retiredKey.\n`, "utf8");
  const red = await request(url, "/api/agents-md/reconcile", readOptions(boot.token));
  assert.equal(red.body.ok, false);
  assert.equal(red.body.findings[0].kind, "unregistered");
  assert.equal(red.body.findings[0].line, 5);
  await writeFile(join(fixture.proseRoot, "AGENTS.md"), greenText, "utf8");
  assert.equal((await request(url, "/api/agents-md/reconcile", readOptions(boot.token))).body.ok, true);
});


// TCRN-CROSS-SUB-338 (STORY-483 AC2; MIN-235 D4, judgment 1.5 (a)): an edit saved through Atelier
// is judged, not rendered. The batch section changed by one character reads user-modified at
// once, AGENTS.md is the bytes saved, and nothing goes pending. A section goes pending only when an
// engine write renders the managed sections (a variable write here); keep then makes it the
// user's, and the engine writes it no more.
test("rules routes expose state, enable a rule, judge a saved edit as user-modified, and settle a pending section with keep", async (t) => {
  const fixture = await scratch("tcrn-portal-rules-", "TCRN-PORTAL-RULES");
  const { child, url } = await startPortal(fixture);
  t.after(async () => { child.kill(); await rm(fixture.base, { recursive: true, force: true }); });
  const { boot } = await readBoot(url);
  const agentsPath = join(fixture.proseRoot, "AGENTS.md");
  const batchOf = (body) => body.rules.find((rule) => rule.id === "batch");
  const libraryVersion = async () => (await cli(["status", "--workspace", fixture.workspace], fixture.deviceEnv)).version;
  const listed = await request(url, "/api/rules", readOptions(boot.token));
  assert.equal(listed.body.reasonCode, "RULE_LIST_READY");
  // The route lists every rule the engine lists, in its order.
  const engineRules = (await cli(["rule-list", "--project", fixture.proseRoot], fixture.deviceEnv)).rules.map((rule) => rule.id);
  assert.ok(engineRules.includes("batch"), "the engine lists its built-in rules");
  assert.deepEqual(listed.body.rules.map((rule) => rule.id), engineRules);
  assert.ok(listed.body.rules.every((rule) => rule.state === "disabled"));

  const enabled = await request(url, "/api/rules/batch", writeOptions(boot.token, "POST", { action: "enable" }));
  assert.equal(enabled.body.reasonCode, "RULE_ENABLED");
  assert.equal(batchOf(enabled.body).state, "enabled");
  const original = await readFile(agentsPath, "utf8");
  assert.match(original, /id=rule:batch/u);
  const edited = original.replace("All open Stories", "All open stories");
  assert.equal([...edited].filter((character, index) => character !== [...original][index]).length, 1, "one character of the rule's text");

  // AC2: the save is judged: user-modified, the file is the bytes saved, and nothing is pending
  // or written to the library.
  const before = await libraryVersion();
  const saved = await request(url, "/api/agents-md", writeOptions(boot.token, "PUT", { file: "AGENTS.md", text: edited }));
  assert.equal(saved.response.status, 200);
  assert.equal(saved.body.reasonCode, "PORTAL_AGENTS_MD_WRITTEN");
  assert.equal(batchOf(saved.body).state, "user-modified");
  assert.deepEqual(saved.body.pending, []);
  assert.equal(Object.hasOwn(saved.body, "render"), false);
  assert.equal(saved.body.text, edited);
  assert.equal(await readFile(agentsPath, "utf8"), edited, "AGENTS.md is the bytes saved; nothing rendered over them");
  assert.equal(await libraryVersion(), before, "a save writes nothing to the library");
  const judged = await request(url, "/api/rules", readOptions(boot.token));
  assert.equal(batchOf(judged.body).state, "user-modified");
  assert.deepEqual(judged.body.pending, []);

  // An engine write renders the managed sections: the section the user changed is left as it is
  // and goes pending.
  const variable = await request(url, "/api/variables", writeOptions(boot.token, "POST", { name: "deploy.host", type: "string", value: "build.example.com", exports: ["agents"] }));
  assert.equal(variable.body.reasonCode, "VARIABLE_WRITE_COMMITTED");
  assert.deepEqual(variable.body.render.pending, [{ id: "rule:batch", file: "AGENTS.md" }]);
  const pending = await request(url, "/api/rules", readOptions(boot.token));
  assert.equal(batchOf(pending.body).state, "pending");
  assert.deepEqual(pending.body.pending, [{ id: "rule:batch", file: "AGENTS.md", ruleId: "batch" }]);
  assert.equal(managedSection(await readFile(agentsPath, "utf8"), "rule:batch").raw, managedSection(edited, "rule:batch").raw);

  // keep makes the section the user's: it reads user-modified, and the engine writes it no more.
  const kept = await request(url, "/api/rules/resolve", writeOptions(boot.token, "POST", { section: "rule:batch", action: "keep" }));
  assert.equal(kept.body.reasonCode, "MANAGED_SECTION_RESOLVED");
  assert.deepEqual(kept.body.pending, []);
  assert.equal(batchOf(kept.body).state, "user-modified");
  const again = await request(url, "/api/variables", writeOptions(boot.token, "POST", { name: "deploy.host", type: "string", value: "stage.example.com", exports: ["agents"] }));
  assert.equal(again.body.reasonCode, "VARIABLE_WRITE_COMMITTED");
  assert.deepEqual(again.body.render.pending, []);
  const settled = await readFile(agentsPath, "utf8");
  assert.match(settled, /stage\.example\.com/u, "the engine still renders the sections it owns");
  assert.equal(managedSection(settled, "rule:batch").raw, managedSection(edited, "rule:batch").raw, "the kept section is the user's text");
  assert.equal(batchOf((await request(url, "/api/rules", readOptions(boot.token))).body).state, "user-modified");

  const forcedOff = await request(url, "/api/rules/batch", writeOptions(boot.token, "POST", { action: "disable", force: true }));
  assert.equal(forcedOff.body.reasonCode, "RULE_DISABLED");
  assert.equal(forcedOff.body.rules.find((rule) => rule.id === "batch").state, "disabled");
  assert.doesNotMatch(await readFile(join(fixture.proseRoot, "AGENTS.md"), "utf8"), /id=rule:batch/u);
});


// TCRN-CROSS-STORY-482 R3: the Rules page belongs to the selected library's registered project,
// so a switch moves it; and the switcher asks the registry on every read (INC-203), so a library
// registered after the portal started can be chosen without a restart.
test("switching the library moves the Rules page to its project, and a library registered later can be chosen", async (t) => {
  const fixture = await scratch("tcrn-portal-conservation-libraries-", "TCRN-PORTAL-CONSERVATION-LIBRARIES");
  await writeFile(join(fixture.proseRoot, "AGENTS.md"), "# first project\n", "utf8");
  await writeFile(join(fixture.second.project, "AGENTS.md"), "# second project\n", "utf8");
  const { child, url } = await startPortal(fixture);
  t.after(async () => { child.kill(); await rm(fixture.base, { recursive: true, force: true }); });
  const { boot } = await readBoot(url);
  assert.equal(boot.proseRoot, fixture.proseRoot);
  assert.equal((await request(url, "/api/agents-md", readOptions(boot.token))).body.text, "# first project\n");

  const selected = await request(url, "/api/library", writeOptions(boot.token, "POST", { library: fixture.second.library }));
  assert.equal(selected.body.reasonCode, "PORTAL_LIBRARY_SELECTED");
  assert.equal(selected.body.proseRoot, fixture.second.project);
  const prose = await request(url, "/api/agents-md", readOptions(boot.token));
  assert.equal(prose.body.text, "# second project\n");
  assert.equal(prose.body.path, join(fixture.second.project, "AGENTS.md"));
  // TCRN-CROSS-SUB-338: the save lands in the second project and is judged there, against the
  // second library, and nothing is rendered into it. Batch is enabled in the second library only,
  // so once the save takes its section out it reads removed-from-file (in the first, disabled).
  await cli(["rule-enable", "--project", fixture.second.project, "--id", "batch", "--at", "2026-08-11T15:30:00Z", "--actor", "agent:test"], { ...fixture.deviceEnv, EINZBERN_SURFACE: "atelier" });
  const written = await request(url, "/api/agents-md", writeOptions(boot.token, "PUT", { file: "AGENTS.md", text: "# second project, edited\n" }));
  assert.equal(written.body.reasonCode, "PORTAL_AGENTS_MD_WRITTEN");
  assert.equal(written.body.text, "# second project, edited\n");
  assert.equal(written.body.rules.find((rule) => rule.id === "batch").state, "removed-from-file");
  assert.equal(await readFile(join(fixture.second.project, "AGENTS.md"), "utf8"), written.body.text);
  assert.equal(await readFile(join(fixture.proseRoot, "AGENTS.md"), "utf8"), "# first project\n", "the first project's rules are untouched");
  const catalog = await request(url, "/api/settings", readOptions(boot.token));
  assert.deepEqual(catalog.body.settings, (await cli(["settings-catalog", "--workspace", fixture.second.library], fixture.deviceEnv)).settings);

  const third = { project: join(fixture.base, "third-project"), library: join(fixture.base, "third-project", ".ether") };
  await registeredLibrary(fixture.deviceEnv, third.project, third.library, "TCRN-PORTAL-CONSERVATION-THIRD", "2026-08-11T15:02:00Z");
  const listed = await request(url, "/api/libraries", readOptions(boot.token));
  assert.deepEqual(listed.body.libraries.map((library) => library.projectPath), [fixture.proseRoot, fixture.second.project, third.project]);
  const later = await request(url, "/api/library", writeOptions(boot.token, "POST", { library: third.library }));
  assert.equal(later.body.reasonCode, "PORTAL_LIBRARY_SELECTED");
  assert.equal(later.body.proseRoot, third.project);
});


test("i18n invariant policy does not waive translated text under the shortcut key", async (t) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-portal-i18n-shortcut-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const sourcePath = join(base, "locales-mutated.js");
  const source = await readFile(join(portalRoot, "locales.js"), "utf8");
  assert.equal(source.split('"search.command": "⌘K"').length, 6);
  await writeFile(sourcePath, source.replaceAll('"search.command": "⌘K"', '"search.command": "Keyboard command"'), "utf8");
  let failure;
  try { await execFileAsync(process.execPath, [join(portalRoot, "scripts", "i18n-proof.mjs")], { encoding: "utf8", env: { ...process.env, TCRN_PORTAL_LOCALES_SOURCE: sourcePath } }); } catch (error) { failure = error; }
  assert.ok(failure);
  const leg = JSON.parse(failure.stdout).legs.find((entry) => entry.leg === "translation-full-table");
  assert.ok(leg.problems.some((problem) => problem.locale === "ja" && problem.unexpected.includes("search.command")));
});


// TCRN-CROSS-STORY-467 R3: the execution route and its page left with the dispatch-* verbs, and the
// dispatch mode setting with TCRN-CROSS-STORY-484 R3. The owner's concurrency limit is a registered
// setting, written and read back through settings.
test("execution settings: the owner scenario writes through settings while the execution route is gone", async (t) => {
  const fixture = await scratch("tcrn-portal-conservation-execution-", "TCRN-PORTAL-CONSERVATION-EXECUTION");
  const { child, url } = await startPortal(fixture);
  t.after(async () => { child.kill(); await rm(fixture.base, { recursive: true, force: true }); });
  const { boot } = await readBoot(url);
  const refusedWrite = await request(url, "/api/execution", writeOptions(boot.token, "POST", { action: "model-plan-set", host: "claude-code", name: "owner-scenario", defaultModel: "opus-5" }));
  assert.equal(refusedWrite.response.status, 404);
  assert.equal(refusedWrite.body.reasonCode, "PORTAL_ROUTE_UNKNOWN");
  const historical = await request(url, "/api/execution", readOptions(boot.token));
  assert.equal(historical.response.status, 404);
  const retiredMode = await request(url, "/api/settings", writeOptions(boot.token, "POST", { key: "execution.dispatchMode", value: "eco" }));
  assert.equal(retiredMode.body.reasonCode, "SETTINGS_KEY_UNREGISTERED");
  const active = await request(url, "/api/settings", writeOptions(boot.token, "POST", { key: "execution.maxConcurrentSubagents", value: "3" }));
  assert.equal(active.body.reasonCode, "SETTINGS_WRITE_COMMITTED");
  assert.equal(active.body.readback.currentValue, "3");
  // TCRN-CROSS-STORY-482 R4: the execution surface's host projection is gone, so the write is
  // answered by the engine receipt alone and renders nothing into a host file.
  assert.equal(Object.hasOwn(active.body, "hostRender"), false);
  const readback = await request(url, "/api/settings", readOptions(boot.token));
  assert.equal(readback.body.settings.find((entry) => entry.key === "execution.maxConcurrentSubagents").currentValue, "3");
  const removed = await request(url, "/api/settings", writeOptions(boot.token, "POST", { key: "execution.maxConcurrentSubagents", reset: true }));
  assert.equal(removed.response.status, 200);
  assert.equal(Object.hasOwn(removed.body, "hostRender"), false);
  assert.equal(removed.body.version, active.body.version + 1, "the reset is the chain's next event and the only one");
});


test("unregistered selection refuses every configuration and prose mutation without changing either chain", async t => {
  const fixture = await scratch("portal-stale-registry-", "STALE-REGISTRY");
  const { child, url } = await startPortal(fixture);
  t.after(async () => { if (child.exitCode === null) { const exited = new Promise(resolve => child.once("exit", resolve)); child.kill(); await exited; } await rm(fixture.base, { recursive: true, force: true }); });
  const { boot } = await readBoot(url);
  const before = await Promise.all([fixture.workspace, fixture.second.library].map(workspace => cli(["status", "--workspace", workspace], fixture.deviceEnv)));
  await unregisterLibrary(fixture.proseRoot, fixture.deviceEnv.EINZBERN_HOME);
  const routes = [
    ["/api/settings", "POST", { key: "artifact.language", value: "fr" }],
    ["/api/project-bindings", "POST", { key: "repositories", value: { bindings: [] } }],
    ["/api/work/involved-projects", "POST", { id: "work:" + "a".repeat(24), revision: 1, involvedProjects: { state: "undecided", targets: [] } }],
    ["/api/variables", "POST", { name: "sample", type: "string", value: "value", description: "description" }],
    ["/api/gates", "DELETE", { name: "sample" }],
    ["/api/rules/autonomy", "POST", { action: "enable" }],
    ["/api/rules/resolve", "POST", { section: "variables-system", action: "keep" }],
    ["/api/agents-md", "PUT", { text: "stale edit" }],
  ];
  for (const [route, method, body] of routes) {
    const result = await request(url, route, writeOptions(boot.token, method, body));
    assert.equal(result.body.ok, false, route);
    assert.equal(result.body.reasonCode, "PORTAL_CONFIGURATION_TARGET_CHANGED", route);
  }
  const after = await Promise.all([fixture.workspace, fixture.second.library].map(workspace => cli(["status", "--workspace", workspace], fixture.deviceEnv)));
  assert.deepEqual(after.map(x => x.headEventHash), before.map(x => x.headEventHash));
});

test("INIT-053 R47 c1-B: a coordination chain's /api/settings lists its runtime settings and writes them for the whole library", async t => {
  const fixture = await scratch("portal-r47-coordination-", "R47-COORDINATION");
  const atelier = { ...fixture.deviceEnv, EINZBERN_SURFACE: "atelier" };
  const libraryId = (await cli(["status", "--workspace", fixture.workspace], fixture.deviceEnv)).workspaceId;
  await cli(["chain-declare", "--workspace", fixture.workspace, "--role", "coordination", "--coordination-library-id", libraryId, "--at", R46_AT, "--actor", "agent:test"], atelier);
  const tiers = (await cli(["settings-catalog", "--workspace", fixture.second.library, "--project-id", fixture.second.projectId], fixture.deviceEnv)).settings.find((entry) => entry.key === "models.tiers").currentValue;
  const { child, url } = await startPortal(fixture);
  t.after(async () => { if (child.exitCode === null) { const exited = new Promise(resolve => child.once("exit", resolve)); child.kill(); await exited; } await rm(fixture.base, { recursive: true, force: true }); });
  const { boot } = await readBoot(url);
  assert.deepEqual([boot.library.chain.role, boot.library.configurationProjectId], ["coordination", fixture.projectId]);
  const settings = await request(url, "/api/settings", readOptions(boot.token));
  assert.equal(settings.body.reasonCode, "SETTINGS_CATALOG_READY");
  assert.deepEqual(settings.body.settings.map((entry) => [entry.key, entry.scope, entry.layer]), R47_COORDINATION_KEYS.map((key) => [key, "library", "library"]));
  const written = await request(url, "/api/settings", writeOptions(boot.token, "POST", { key: "artifact.language", value: "fr" }));
  assert.equal(written.response.status, 200);
  assert.deepEqual([written.body.reasonCode, written.body.readback.currentValue, written.body.readback.declaredValue, written.body.readback.source.kind], ["SETTINGS_WRITE_COMMITTED", "fr", "fr", "library"]);
  const library = (await cli(["settings-catalog", "--workspace", fixture.workspace], fixture.deviceEnv)).settings.find((entry) => entry.key === "artifact.language");
  assert.deepEqual([library.currentValue, library.declaredValue, library.source.kind], ["fr", "fr", "library"], "the write is the library's, not the project's");
  const refused = await request(url, "/api/settings", writeOptions(boot.token, "POST", { key: "models.tiers", value: tiers }));
  assert.equal(refused.response.status, 409);
  assert.equal(refused.body.ok, false);
  assert.equal(refused.body.reasonCode, "SETTINGS_KEY_DEVICE_LEVEL");
  assert.match(refused.body.error, /historical compatibility data/u);
  const after = await cli(["settings-catalog", "--workspace", fixture.workspace, "--project-id", fixture.projectId], fixture.deviceEnv);
  assert.deepEqual(after.settings.map((entry) => entry.key), R47_COORDINATION_KEYS, "models.tiers is not listed and was not written");
});


test("526 GWT4: Atelier started with TCRN_PORTAL_ACTOR saves a gate whose event records surface atelier and that actor", async (t) => {
  const fixture = await scratch("tcrn-portal-actor-", "TCRN-PORTAL-ACTOR");
  // A library that records its writers (attestation enabled), so the event names the actor.
  await asDevice(fixture, () => appendHistoricalAttestationEnable(fixture.workspace, { occurredAt: "2026-08-11T15:00:30Z", actorId: "owner:governance" }));
  const actor = "agent:test-atelier-writer";
  const { child, url, listening } = await startPortal({ ...fixture, env: { TCRN_PORTAL_ACTOR: actor } });
  t.after(async () => { child.kill(); await rm(fixture.base, { recursive: true, force: true }); });
  assert.equal(listening.actor, actor);
  const { boot } = await readBoot(url);
  const saved = await request(url, "/api/gates", writeOptions(boot.token, "POST", { name: "unit", command: ["node", "--version"], root: ".", covers: ["**"], enabled: true, required: true, releaseOnly: false }));
  assert.equal(saved.response.status, 200, JSON.stringify(saved.body));
  // The last event is read back through the CLI's event page, the route the portal's dependency
  // audit sanctions, not from an engine package (TCRN-CROSS-SUB-468).
  const { total } = await cli(["event-list", "--workspace", fixture.workspace, "--limit", "1"], fixture.deviceEnv);
  const event = (await cli(["event-list", "--workspace", fixture.workspace, "--offset", String(total - 1)], fixture.deviceEnv)).records.at(-1).payload;
  assert.deepEqual([event.operation, event.record.collection, event.record.key, event.surface, event.actor], ["config.record.set", "gate", "unit", "atelier", actor]);
  assert.equal(Object.hasOwn(event, "decidedIn"), false, "a run for Atelier cites no decision");
});
