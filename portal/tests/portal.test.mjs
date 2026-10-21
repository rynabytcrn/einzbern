// SPDX-License-Identifier: Apache-2.0
// Tests in this file run sequentially; Node isolates each file in a process.
import { CLI, R46_AT, RETIRED_PERSONA_ACTIONS, RETIRED_ROUTES, TEST_ACTOR, appendHistoricalModelSetting, assert, cli, clientTargets, execFileAsync, httpRequest, join, mkdir, mkdtemp, portalRoot, readBoot, readFile, readOptions, realpath, request, rm, scratch, spawn, startPortal, startupRefusal, test, tmpdir, unregisterLibrary, writeFile, writeOptions } from "./portal-support.mjs";



test("portal boots from the live engine and exposes the new read surfaces", async (t) => {
  const fixture = await scratch("tcrn-portal-read-", "TCRN-PORTAL-READ");
  const { child, url } = await startPortal(fixture);
  t.after(async () => { child.kill(); await rm(fixture.base, { recursive: true, force: true }); });
  const { page, boot } = await readBoot(url);
  assert.equal(boot.workspace, fixture.workspace);
  assert.equal(boot.library.libraryPath, fixture.workspace);
  assert.equal(boot.libraries.length, 2);
  for (const retired of ["partitionMode", "partitions", "selectedPartition", "container"]) assert.equal(Object.hasOwn(boot, retired), false, retired);
  assert.match(page, /data-page="dashboard"/u);
  assert.match(page, /data-page="variables"/u);
  assert.match(page, /data-page="gates"/u);
  assert.match(page, /data-page="vocabulary"/u);

  const settings = await request(url, "/api/settings", readOptions(boot.token));
  assert.equal(settings.body.reasonCode, "SETTINGS_CATALOG_READY");
  assert.equal(settings.body.modelPolicy.source.kind, "device-engine");
  assert.equal(settings.body.modelPolicy.compatibility.projectOverrideAllowed, false);
  // TCRN-CROSS-STORY-484 R3: the two subagent-plan settings are retired with the dispatch keys.
  assert.deepEqual(settings.body.settings.filter((entry) => entry.key.includes("SubagentPlan") || entry.key.startsWith("execution.dispatch")).map((entry) => entry.key), []);
  // TCRN-CROSS-STORY-467 R3: the execution projection read the dispatch-* verbs and left with
  // them; the route answers as unknown rather than from a retired verb.
  const execution = await request(url, "/api/execution", readOptions(boot.token));
  assert.equal(execution.response.status, 404);
  assert.equal(execution.body.reasonCode, "PORTAL_ROUTE_UNKNOWN");
  const dictionary = await request(url, "/api/vocabulary", readOptions(boot.token));
  assert.equal(dictionary.body.reasonCode, "VOCABULARY_READY");
  assert.equal(Object.hasOwn(dictionary.body, "roles"), false);
  assert.equal(Object.hasOwn(dictionary.body, "efforts"), false);
  assert.ok(dictionary.body.hosts.includes("codex"));
  const variables = await request(url, "/api/variables", readOptions(boot.token));
  assert.equal(variables.body.reasonCode, "VARIABLE_LIST_READY");
  assert.deepEqual(variables.body.variables, []);
});



test("portal writes carry the actor under the engine's write lock, then return the engine receipt and readback", async (t) => {
  const fixture = await scratch("tcrn-portal-write-", "TCRN-PORTAL-WRITE");
  const { child, url } = await startPortal(fixture);
  t.after(async () => { child.kill(); await rm(fixture.base, { recursive: true, force: true }); });
  const { boot } = await readBoot(url);

  const untokened = await request(url, "/api/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: "retrieval.tau", value: "3" }) });
  assert.equal(untokened.response.status, 403);
  assert.equal(untokened.body.reasonCode, "PORTAL_TOKEN_REQUIRED");

  const setting = await request(url, "/api/settings", writeOptions(boot.token, "POST", { key: "retrieval.tau", value: "3" }));
  assert.equal(setting.response.status, 200);
  assert.equal(setting.body.reasonCode, "SETTINGS_WRITE_COMMITTED");
  assert.equal(setting.body.readback.currentValue, "3");

  // TCRN-CROSS-STORY-484 R3, TCRN-CROSS-STORY-508 R2: models.tiers is a table of records, each filed
  // under a category with its runner (TCRN-CROSS-SUB-409 replaced the per-host value written here).
  const tiers = await request(url, "/api/settings", writeOptions(boot.token, "POST", {
    key: "models.tiers",
    value: JSON.stringify([{ order: 10, category: "main", runner: "claude-code", model: "opus-5", effort: "xhigh2", note: "" }]),
  }));
  assert.equal(tiers.response.status, 409);
  assert.equal(tiers.body.reasonCode, "SETTINGS_KEY_DEVICE_LEVEL");
  assert.equal(Object.hasOwn(tiers.body, "hostRender"), false);
  // The dispatch classes and modes retired with TCRN-CROSS-STORY-484 R3: a write is refused and appends nothing.
  const retiredClasses = await request(url, "/api/settings", writeOptions(boot.token, "POST", {
    key: "execution.dispatchClasses",
    value: JSON.stringify({ "review-visual": { dispatch: true, verify: false } }),
  }));
  assert.equal(retiredClasses.response.status, 409);
  assert.equal(retiredClasses.body.reasonCode, "SETTINGS_KEY_UNREGISTERED");
  const parallelOff = await request(url, "/api/settings", writeOptions(boot.token, "POST", { key: "quota.fiveHourParallelOffPercent", value: "80" }));
  assert.equal(parallelOff.body.reasonCode, "SETTINGS_KEY_DEVICE_LEVEL");
  const wait = await request(url, "/api/settings", writeOptions(boot.token, "POST", { key: "quota.fiveHourWaitPercent", value: "95" }));
  assert.equal(wait.body.reasonCode, "SETTINGS_KEY_DEVICE_LEVEL");
  // TCRN-CROSS-STORY-467 R3: the execution write route carried the dispatch-* writes and the
  // retired plan and persona actions. It is gone, so those posts reach no writer and leave
  // nothing in the session audit.
  const retired = await request(url, "/api/execution", writeOptions(boot.token, "POST", { action: "model-plan-set", host: "claude-code", name: "daily", defaultModel: "opus-5" }));
  assert.equal(retired.response.status, 404);
  assert.equal(retired.body.reasonCode, "PORTAL_ROUTE_UNKNOWN");
  const active = await request(url, "/api/settings", writeOptions(boot.token, "POST", { key: "execution.maxConcurrentSubagents", value: "3" }));
  assert.equal(active.body.reasonCode, "SETTINGS_WRITE_COMMITTED");
  const retiredPersona = await request(url, "/api/execution", writeOptions(boot.token, "POST", { action: RETIRED_PERSONA_ACTIONS.override, name: "Verity", fields: { mission: "Review governed evidence", role: "reviewer" } }));
  assert.equal(retiredPersona.response.status, 404);
  assert.equal(retiredPersona.body.reasonCode, "PORTAL_ROUTE_UNKNOWN");

  // TCRN-CROSS-STORY-482 R4: the session audit left with its page. Each settings write is answered
  // by the engine's receipt; compatibility-only policy writes append no version.
  for (const receipt of [setting, active]) assert.ok(receipt.body.receiptDigest && receipt.body.headEventHash && receipt.body.version);
  const versions = [setting.body.version, active.body.version];
  assert.ok(versions.every((version, index) => Number.isInteger(version) && (index === 0 || version > versions[index - 1])));

  const audit = await request(url, RETIRED_ROUTES.sessionAudit, readOptions(boot.token));
  assert.equal(audit.response.status, 404);
  assert.equal(audit.body.reasonCode, "PORTAL_ROUTE_UNKNOWN");
});



test("the page boots with the shipped locale contract and needs nothing outside the portal", async (t) => {
  const fixture = await scratch("tcrn-portal-conservation-locale-", "TCRN-PORTAL-CONSERVATION-LOCALE");
  const { child, url } = await startPortal(fixture);
  t.after(async () => { child.kill(); await rm(fixture.base, { recursive: true, force: true }); });
  const response = await fetch(url);
  assert.equal(response.status, 200);
  const page = await response.text();
  assert.ok(!page.includes("__PORTAL_BOOT__"));
  const boot = JSON.parse(page.match(/const BOOT = (\{.*\});/u)[1]);
  const { LOCALE_CONTRACT } = await import("../locale-contract.mjs");
  assert.deepEqual(boot.supportedLocales, [...LOCALE_CONTRACT.supportedLocales]);
  assert.equal(boot.fallbackLocale, LOCALE_CONTRACT.fallbackLocale);
  assert.equal(boot.localeMetadata.length, LOCALE_CONTRACT.localeMetadata.length);
  assert.ok(boot.localeMetadata.every((entry) => entry.nativeName.length > 0));
  const locales = await (await fetch(new URL("/locales.js", url))).text();
  assert.match(locales, /window\.PORTAL_LOCALES/u);
  for (const locale of LOCALE_CONTRACT.supportedLocales) assert.ok(locales.includes(`"${locale}"`) || locales.includes(`${locale}:`));
});



test("i18n proof turns red when the engine drops enum allowedValues", async (t) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-portal-conservation-i18n-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const shim = join(base, "strip-catalog.mjs");
  await writeFile(shim, `import { execFileSync } from "node:child_process"; const output = execFileSync(process.execPath, [process.env.TCRN_REAL_CLI, ...process.argv.slice(2)], { encoding: "utf8" }); const body = JSON.parse(output); if (process.argv[2] === "settings-catalog") for (const entry of body.settings ?? []) delete entry.allowedValues; process.stdout.write(JSON.stringify(body));\n`, "utf8");
  let failure;
  try { await execFileAsync(process.execPath, [join(portalRoot, "scripts", "i18n-proof.mjs")], { encoding: "utf8", env: { ...process.env, TCRN_WORKFLOW_CLI: shim, TCRN_REAL_CLI: CLI } }); } catch (error) { failure = error; }
  assert.ok(failure);
  const report = JSON.parse(failure.stdout);
  assert.equal(report.ok, false);
  assert.equal(report.reasonCode, "I18N_CONTRACT_VIOLATION");
  const leg = report.legs.find((entry) => entry.leg === "setting-descriptions");
  assert.equal(leg.reasonCode, "SETTING_ENUM_VALUES_GAP");
  // TCRN-CROSS-STORY-484 R3 retired the other enum settings; artifact.language is the one left.
  assert.ok(leg.enumMissingAllowedValues.includes("artifact.language"));
});



test("i18n full-table proof turns red when an existing translation regresses", async (t) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-portal-i18n-full-table-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const sourcePath = join(base, "locales-mutated.js");
  const source = await readFile(join(portalRoot, "locales.js"), "utf8");
  const anchor = '"receipt.title": "エンジンの操作記録"';
  assert.equal(source.split(anchor).length, 2, "the Japanese fixture matches exactly one current translation");
  await writeFile(sourcePath, source.replace(anchor, '"receipt.title": "Engine operation record"'), "utf8");
  let failure;
  try {
    await execFileAsync(process.execPath, [join(portalRoot, "scripts", "i18n-proof.mjs")], { encoding: "utf8", env: { ...process.env, TCRN_PORTAL_LOCALES_SOURCE: sourcePath } });
  } catch (error) { failure = error; }
  assert.ok(failure);
  const report = JSON.parse(failure.stdout);
  const leg = report.legs.find((entry) => entry.leg === "translation-full-table");
  assert.equal(leg.reasonCode, "FULL_LOCALE_TABLE_REALITY_GAP");
  assert.ok(leg.problems.some((problem) => problem.locale === "ja" && problem.unexpected.includes("receipt.title")));
});



// R46 I01 (approved contract item 2; EPIC-144 R3; Owner return 2): the name of a library and of a target
// is its project's canonical name, end to end. A registration that names no project, and a coordination
// chain registered without one, answer null rather than an English stand-in, in /api/libraries, the
// boot and /api/library; a project chain's target answers its project's name.
test("INIT-053 R46 I01: names come from the project records, and a registration without a project answers null", async t => {
  const fixture = await scratch("portal-r46-names-", "R46-NAMES");
  const atelier = { ...fixture.deviceEnv, EINZBERN_SURFACE: "atelier" };
  // A coordination chain registered as its own project path, with no project.
  const bare = join(fixture.base, "bare-coordination");
  await cli(["init", "--workspace", bare, "--at", R46_AT], fixture.deviceEnv);
  const bareId = (await cli(["status", "--workspace", bare], fixture.deviceEnv)).workspaceId;
  await cli(["chain-declare", "--workspace", bare, "--role", "coordination", "--coordination-library-id", bareId, "--at", R46_AT, "--actor", "agent:test"], atelier);
  await cli(["library-register", "--project", bare, "--library", bare, "--at", R46_AT], fixture.deviceEnv);
  // The second library is a project chain of it, and has a second registration that names no project.
  await cli(["chain-declare", "--workspace", fixture.second.library, "--role", "project", "--coordination-library-id", bareId, "--at", R46_AT, "--actor", "agent:test"], atelier);
  const unnamed = join(fixture.base, "unnamed-project");
  await mkdir(unnamed);
  await cli(["library-register", "--project", unnamed, "--library", fixture.second.library, "--at", R46_AT], fixture.deviceEnv);
  assert.deepEqual((await cli(["project-list", "--workspace", fixture.second.library], fixture.deviceEnv)).records.map(record => [record.id, record.name]), [[fixture.second.projectId, "R46-NAMES-SECOND"]]);

  const { child, url } = await startPortal({ ...fixture, library: bare });
  t.after(async () => { if (child.exitCode === null) { const exited = new Promise(resolve => child.once("exit", resolve)); child.kill(); await exited; } await rm(fixture.base, { recursive: true, force: true }); });
  const { boot } = await readBoot(url);
  assert.deepEqual([boot.library.chain.role, boot.library.name, boot.libraryName], ["coordination", null, null], "a coordination chain without a project has no name, and no stand-in");
  const listed = await request(url, "/api/libraries", readOptions(boot.token));
  const nameAt = (path) => listed.body.libraries.find(entry => entry.projectPath === path).name;
  assert.deepEqual([nameAt(fixture.proseRoot), nameAt(fixture.second.project), nameAt(unnamed), nameAt(bare)], ["R46-NAMES", "R46-NAMES-SECOND", null, null]);
  const secondId = (await cli(["status", "--workspace", fixture.second.library], fixture.deviceEnv)).workspaceId;
  const targets = await request(url, "/api/project-targets", readOptions(boot.token));
  assert.deepEqual(targets.body.targets, [{ libraryId: secondId, projectId: fixture.second.projectId, name: "R46-NAMES-SECOND" }]);
  const toUnnamed = await request(url, "/api/library", writeOptions(boot.token, "POST", { library: unnamed }));
  assert.deepEqual([toUnnamed.response.status, toUnnamed.body.libraryName, toUnnamed.body.library.name, toUnnamed.body.proseRoot], [200, null, null, null], "a registration without a project is unnamed and has no prose output");
  const toFirst = await request(url, "/api/library", writeOptions(boot.token, "POST", { library: fixture.proseRoot }));
  assert.deepEqual([toFirst.body.libraryName, toFirst.body.library.name], ["R46-NAMES", "R46-NAMES"]);
  for (const answer of [boot, listed.body, targets.body, toUnnamed.body, toFirst.body]) {
    assert.doesNotMatch(JSON.stringify(answer), /Unconfigured project|"Cross Project"/u, "no English stand-in name");
  }
  assert.equal((await readFile(join(portalRoot, "portal.mjs"), "utf8")).includes("Unconfigured project"), false);
});



// R46 I06 (approved contract items 2, 10; U20 D2): one chain's two repositories are two registrations,
// and each is bound by its own project path: /api/library, /api/configuration-scope and GET/PUT
// /api/agents-md name the selected registration's root. A project of the library that several
// registrations name is ambiguous, and none of them is taken.
test("INIT-053 R46 I06: a chain's two repositories bind by registration, and a project with several registrations is ambiguous", async t => {
  const fixture = await scratch("portal-r46-bind-", "R46-BIND");
  const mana = join(fixture.base, "second-mana");
  await mkdir(mana);
  await cli(["library-register", "--project", mana, "--library", fixture.second.library, "--project-id", fixture.second.projectId, "--at", R46_AT], fixture.deviceEnv);
  const other = (await cli(["project-create", "--workspace", fixture.second.library, "--external-key", "R46-BIND-OTHER", "--name", "Other", "--at", R46_AT], fixture.deviceEnv)).record.id;
  const otherRoots = [join(fixture.base, "other-a"), join(fixture.base, "other-b")];
  for (const root of otherRoots) {
    await mkdir(root);
    await cli(["library-register", "--project", root, "--library", fixture.second.library, "--project-id", other, "--at", R46_AT], fixture.deviceEnv);
  }
  const { child, url } = await startPortal(fixture);
  t.after(async () => { if (child.exitCode === null) { const exited = new Promise(resolve => child.once("exit", resolve)); child.kill(); await exited; } await rm(fixture.base, { recursive: true, force: true }); });
  const { boot } = await readBoot(url);
  const agentsFile = (root) => join(root, "AGENTS.md");
  for (const [root, sibling] of [[mana, fixture.second.project], [fixture.second.project, mana]]) {
    const selected = await request(url, "/api/library", writeOptions(boot.token, "POST", { library: root }));
    assert.deepEqual([selected.response.status, selected.body.proseRoot], [200, root], `${root}: the switch names the selected registration's root`);
    const scoped = await request(url, "/api/configuration-scope", writeOptions(boot.token, "POST", { projectId: fixture.second.projectId }));
    assert.deepEqual([scoped.body.proseRoot, scoped.body.outputBindingStatus], [root, "bound"]);
    const read = await request(url, "/api/agents-md", readOptions(boot.token));
    assert.equal(read.body.path, agentsFile(root));
    const text = `# AGENTS.md of ${root}\n`;
    const written = await request(url, "/api/agents-md", writeOptions(boot.token, "PUT", { text }));
    assert.deepEqual([written.response.status, written.body.path], [200, agentsFile(root)], JSON.stringify(written.body));
    assert.equal(await readFile(agentsFile(root), "utf8"), text);
    if (root === mana) await assert.rejects(readFile(agentsFile(sibling)), { code: "ENOENT" }, "the other repository's file is untouched");
    else assert.equal(await readFile(agentsFile(sibling), "utf8"), `# AGENTS.md of ${sibling}\n`, "the other repository's file is untouched");
  }
  // The library's other project has two registrations: switching the configuration target to it
  // takes neither, and names both.
  const ambiguous = await request(url, "/api/configuration-scope", writeOptions(boot.token, "POST", { projectId: other }));
  assert.equal(ambiguous.response.status, 200, JSON.stringify(ambiguous.body));
  assert.deepEqual([ambiguous.body.outputBindingStatus, ambiguous.body.proseRoot, [...ambiguous.body.candidates].sort()], ["ambiguous", null, [...otherRoots].sort()]);
  const read = await request(url, "/api/agents-md", readOptions(boot.token));
  assert.deepEqual([read.response.status, read.body.reasonCode, read.body.outputBindingStatus, [...read.body.candidates].sort()], [409, "PORTAL_PROJECT_BINDING_AMBIGUOUS", "ambiguous", [...otherRoots].sort()]);
  const write = await request(url, "/api/agents-md", writeOptions(boot.token, "PUT", { text: "# not written\n" }));
  assert.deepEqual([write.response.status, write.body.reasonCode], [409, "PORTAL_PROJECT_BINDING_AMBIGUOUS"]);
  for (const root of otherRoots) await assert.rejects(readFile(agentsFile(root)), { code: "ENOENT" });
  const rule = await request(url, "/api/rules/autonomy", writeOptions(boot.token, "POST", { action: "enable" }));
  assert.deepEqual([rule.body.ok, rule.body.reasonCode, [...rule.body.candidates].sort()], [false, "PORTAL_PROJECT_BINDING_AMBIGUOUS", [...otherRoots].sort()]);
});



test("526 GWT4: without TCRN_PORTAL_ACTOR, or with it empty, Atelier and its generated launcher refuse to start with exit code 2 and one JSON line", async (t) => {
  const fixture = await scratch("tcrn-portal-no-actor-", "TCRN-PORTAL-NO-ACTOR");
  t.after(() => rm(fixture.base, { recursive: true, force: true }));
  for (const value of [undefined, "", "   "]) {
    const refused = await startupRefusal(["--library", fixture.workspace], { ...fixture.deviceEnv, HOME: fixture.home, TCRN_PORTAL_ACTOR: value });
    assert.deepEqual([refused.status, refused.lines, refused.report.ok, refused.report.reasonCode, refused.report.variable], [2, 1, false, "PORTAL_ACTOR_REQUIRED", "TCRN_PORTAL_ACTOR"], JSON.stringify(value));
  }
  // A generated launcher carries no actor: it passes on the one its environment holds, and without one Atelier refuses.
  const outputDir = join(fixture.base, "launchers");
  await mkdir(outputDir);
  const generator = join(portalRoot, "scripts", "generate-launchers.mjs");
  const report = JSON.parse((await execFileAsync(process.execPath, [generator, "--library", fixture.workspace, "--output-dir", outputDir, "--port", "0"], { encoding: "utf8" })).stdout);
  for (const file of report.files) assert.doesNotMatch(await readFile(file, "utf8"), /agent:|owner:|profile:/u, `${file} names no actor`);
  const command = report.files.find((file) => file.endsWith(".command"));
  const env = { ...process.env, TCRN_WORKFLOW_CLI: CLI, ...fixture.deviceEnv, HOME: fixture.home };
  delete env.TCRN_PORTAL_ACTOR;
  const launched = await new Promise((resolveRun) => {
    const child = spawn(command, [], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("exit", (code) => resolveRun({ status: code, lines: stderr.trim().split("\n") }));
  });
  assert.deepEqual([launched.status, launched.lines.length, JSON.parse(launched.lines[0]).reasonCode], [2, 1, "PORTAL_ACTOR_REQUIRED"]);
});



test("BL31 a busy loopback port returns a structured startup failure", async (t) => {
  const fixture = await scratch("tcrn-portal-port-busy-", "PORTAL-PORT-BUSY");
  const running = await startPortal(fixture);
  t.after(async () => { running.child.kill(); await rm(fixture.base, { recursive: true, force: true }); });
  const port = new URL(running.url).port;
  await assert.rejects(execFileAsync(process.execPath, [join(portalRoot, "portal.mjs"), "--library", fixture.workspace, "--port", port], {
    env: { ...process.env, ...fixture.deviceEnv, HOME: fixture.home, TCRN_WORKFLOW_CLI: CLI, TCRN_PORTAL_ACTOR: TEST_ACTOR }, encoding: "utf8",
  }), (error) => {
    assert.equal(error.code, 1);
    const failure = JSON.parse(error.stderr.trim());
    assert.equal(failure.reasonCode, "PORTAL_PORT_IN_USE");
    assert.equal(failure.port, Number(port));
    assert.equal(failure.error, "EADDRINUSE");
    assert.ok(failure.recovery.includes("--port"));
    return true;
  });
  assert.equal((await fetch(running.url)).status, 200, "the existing listener remains available");
});



test("portal serves live catalog, commits a governed write, and refuses an untokened one", async (t) => {
  const fixture = await scratch("tcrn-portal-conservation-read-", "TCRN-PORTAL-CONSERVATION-READ");
  const { child, url } = await startPortal(fixture);
  t.after(async () => { child.kill(); await rm(fixture.base, { recursive: true, force: true }); });
  const { page, boot } = await readBoot(url);
  assert.ok(!page.includes("__PORTAL_BOOT__"));
  assert.ok(boot.token.length >= 32);
  const catalog = await request(url, "/api/settings", readOptions(boot.token));
  const engineCatalog = await cli(["settings-catalog", "--workspace", fixture.workspace], fixture.deviceEnv);
  assert.deepEqual(catalog.body.settings, engineCatalog.settings);
  assert.ok(!page.includes("gate-close"));
  assert.match(page, /data-setting-control/u);
  assert.ok(catalog.body.settings.every((entry) => entry.controlType));
  const untokened = await request(url, "/api/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: "retrieval.tau", value: "3" }) });
  assert.equal(untokened.response.status, 403);
  assert.equal(untokened.body.reasonCode, "PORTAL_TOKEN_REQUIRED");
  const committed = await request(url, "/api/settings", writeOptions(boot.token, "POST", { key: "retrieval.tau", value: "3" }));
  assert.equal(committed.body.reasonCode, "SETTINGS_WRITE_COMMITTED");
  assert.equal(committed.body.setting.value, "3");
  assert.equal(committed.body.readback.currentValue, "3");
  assert.ok(committed.body.receiptDigest && committed.body.headEventHash);
  const refused = await request(url, "/api/settings", writeOptions(boot.token, "POST", { key: "bogus.key", value: "x" }));
  assert.equal(refused.response.status, 409);
  assert.equal(refused.body.reasonCode, "SETTINGS_KEY_UNREGISTERED");
  const status = await request(url, "/api/status", readOptions(boot.token));
  assert.equal(status.body.checks.length, 8);
  assert.ok(status.body.checks.every((check) => Object.hasOwn(check, "check") && Object.hasOwn(check, "reasonCode") && Object.hasOwn(check, "detail")));
  assert.deepEqual(Object.keys(status.body.library).sort(), ["configProjection", "rejectedEventCount", "streams", "versionVector"]);
  const commands = await request(url, "/api/commands", readOptions(boot.token));
  assert.ok(commands.body.commands.some((entry) => entry.name === "settings-set" && entry.mutates));
});



test("an admitted request whose body is still in flight refuses an unregistered binding", async t => {
  const fixture = await scratch("portal-inflight-registry-", "INFLIGHT-REGISTRY");
  const { child, url } = await startPortal(fixture);
  t.after(async () => { if (child.exitCode === null) { const exited = new Promise(resolve => child.once("exit", resolve)); child.kill(); await exited; } await rm(fixture.base, { recursive: true, force: true }); });
  const { boot } = await readBoot(url);
  const before = await cli(["status", "--workspace", fixture.workspace], fixture.deviceEnv);
  const body = JSON.stringify({ key: "artifact.language", value: "fr" });
  let req;
  const completed = new Promise((resolve, reject) => {
    req = httpRequest(new URL("/api/settings", url), { method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), "x-portal-token": boot.token, "x-configuration-target": JSON.stringify(clientTargets.get(boot.token)) } }, response => {
      let text = ""; response.on("data", chunk => { text += chunk; }); response.on("end", () => resolve(JSON.parse(text)));
    });
    req.on("error", reject); req.flushHeaders(); req.write(body.slice(0, 1));
  });
  await unregisterLibrary(fixture.proseRoot, fixture.deviceEnv.EINZBERN_HOME);
  req.end(body.slice(1));
  assert.equal((await completed).reasonCode, "PORTAL_CONFIGURATION_TARGET_CHANGED");
  assert.equal((await cli(["status", "--workspace", fixture.workspace], fixture.deviceEnv)).headEventHash, before.headEventHash);
});



test("STORY-379 read views use CLI projections and keep partial data visible", async (t) => {
  const fixture = await scratch("tcrn-portal-views-", "TCRN-PORTAL-VIEWS");
  const { child, url } = await startPortal(fixture);
  t.after(async () => { child.kill(); await rm(fixture.base, { recursive: true, force: true }); });
  const { page, boot } = await readBoot(url);
  for (const tab of ["work", "knowledge"]) assert.match(page, new RegExp(`data-workspace-tab="${tab}"`, "u"));
  // TCRN-CROSS-STORY-485: gate configuration is its own destination, not a workspace tab.
  // TCRN-CROSS-STORY-482 R4: the evolution panel and the session audit left with their mechanisms.
  for (const tab of ["gates", "evolution", "audit"]) assert.doesNotMatch(page, new RegExp(`data-workspace-tab="${tab}"`, "u"));

  const work = await request(url, "/api/work", readOptions(boot.token));
  assert.equal(work.body.reasonCode, "PORTAL_WORK_READY");
  assert.ok(Array.isArray(work.body.records));
  const knowledge = await request(url, "/api/knowledge", readOptions(boot.token));
  assert.match(knowledge.body.reasonCode, /^PORTAL_KNOWLEDGE_/u);
  assert.ok(Array.isArray(knowledge.body.records));
  const gates = await request(url, "/api/gates", readOptions(boot.token));
  assert.equal(gates.response.status, 200);
  assert.equal(gates.body.reasonCode, "PORTAL_GATES_READY");
  assert.deepEqual(gates.body.gates, []);

  const untokened = await request(url, "/api/work");
  assert.equal(untokened.response.status, 403);
  assert.equal(untokened.body.reasonCode, "PORTAL_TOKEN_REQUIRED");
});



// TCRN-CROSS-STORY-482 R4, AC3: the pages that showed the retired mechanisms went with them, and
// so did their routes. The old execution and evolution projections, the session audit and the
// host probe answer as unknown routes, exactly like a path the portal never had; the token check
// still comes first.
test("STORY-482 AC3: the retired execution, evolution and session audit routes answer 404", async (t) => {
  const fixture = await scratch("tcrn-portal-ac3-", "TCRN-PORTAL-AC3");
  const { child, url } = await startPortal(fixture);
  t.after(async () => { child.kill(); await rm(fixture.base, { recursive: true, force: true }); });
  const { page, boot } = await readBoot(url);
  for (const path of ["/api/execution", RETIRED_ROUTES.evolution, RETIRED_ROUTES.sessionAudit, "/api/no-such-route"]) {
    const read = await request(url, path, readOptions(boot.token));
    assert.equal(read.response.status, 404, `GET ${path}`);
    assert.equal(read.body.reasonCode, "PORTAL_ROUTE_UNKNOWN", `GET ${path}`);
  }
  for (const path of ["/api/execution", RETIRED_ROUTES.evolution]) {
    const write = await request(url, path, writeOptions(boot.token, "POST", {}));
    assert.equal(write.response.status, 404, `POST ${path}`);
    assert.equal(write.body.reasonCode, "PORTAL_ROUTE_UNKNOWN", `POST ${path}`);
  }
  const untokened = await request(url, RETIRED_ROUTES.evolution);
  assert.equal(untokened.response.status, 403);
  assert.equal(untokened.body.reasonCode, "PORTAL_TOKEN_REQUIRED");
  // The page asks for none of them.
  for (const path of [RETIRED_ROUTES.evolution, RETIRED_ROUTES.sessionAudit, RETIRED_ROUTES.hostProbe, "/api/execution"]) {
    assert.equal(page.includes(`"${path}"`), false, `the page must not request ${path}`);
  }
});



// STORY-508 collection negatives migrate to INIT-056's one governed host-policy writer.
// Historical project declarations remain readable and cannot configure a host or accept set/reset.
test("SUB-409 (STORY-508 R6): historical collections remain readable and governed host writes preserve collection negatives", async (t) => {
  const fixture = await scratch("tcrn-portal-collections-", "TCRN-PORTAL-COLLECTIONS");
  const { child, url } = await startPortal(fixture);
  t.after(async () => { child.kill(); await rm(fixture.base, { recursive: true, force: true }); });
  const { boot } = await readBoot(url);
  const version = async () => (await cli(["status", "--workspace", fixture.workspace], fixture.deviceEnv)).version;
  const category = (order, id, name = id, description = "") => ({ order, id, name, description });
  const tier = (order, categoryId, runner, model, effort, note = "") => ({ order, category: categoryId, runner, model, effort, note });
  const categories = [category(10, "flagship"), category(20, "main"), category(25, "review", "Review", "A second look"), category(30, "economy")];
  const tiers = [tier(10, "flagship", "codex", "gpt-6", "high"), tier(20, "main", "claude-code", "opus-5", "max"), tier(35, "review", "claude-code", "opus-review", "high", "second look"), tier(40, "economy", "claude-code", "haiku-5", "low")];

  // Historical records remain readable but cannot become a second active policy authority.
  const occurredAt = "2026-10-17T04:00:00Z";
  for (const [key, value] of [["models.category", categories], ["models.tiers", tiers]]) {
    await appendHistoricalModelSetting(["settings-set", "--workspace", fixture.workspace, "--key", key, "--value", JSON.stringify(value), "--at", occurredAt]);
  }
  const historical = await request(url, "/api/settings", readOptions(boot.token));
  assert.deepEqual(JSON.parse(historical.body.settings.find((row) => row.key === "models.tiers").currentValue), tiers);
  const before = await version();
  for (const key of ["models.category", "models.tiers", "models.escalation.ceiling", "quota.fiveHourWaitPercent"]) {
    for (const body of [{ key, value: "[]" }, { key, reset: true }]) {
      const refused = await request(url, "/api/settings", writeOptions(boot.token, "POST", body));
      assert.equal(refused.response.status, 409);
      assert.equal(refused.body.reasonCode, "SETTINGS_KEY_DEVICE_LEVEL");
    }
  }
  assert.equal(await version(), before, "legacy set and reset append nothing");
  const empty = await request(url, "/api/model-policy?host=codex", readOptions(boot.token));
  assert.equal(empty.body.selectedStatus, "unconfigured", "historical tiers never configure Codex");

  // Whole-table validation now belongs to the governed host policy, not project settings.
  const meeting = await cli(["minutes-record", "--workspace", fixture.workspace, "--at", "2026-10-17T04:01:00Z", "--project-id", fixture.projectId, "--external-key", "COLLECTION-POLICY-OWNER", "--title", "Host policy", "--summary", "Owner authorizes host policy.", "--decisions", "Set models.engine-policy for Codex.", "--decided-by", "owner:governance", "--actor", TEST_ACTOR], fixture.deviceEnv);
  const policy = { categories, tiers: tiers.map((row) => ({ ...row, runner: "codex" })), escalation: { enabled: true, threshold: 2, ceiling: "main" } };
  const writePolicy = (value) => request(url, "/api/model-policy", writeOptions(boot.token, "POST", { host: "codex", policy: value, decidedIn: `${meeting.id}#D1`, libraryId: boot.library.libraryId, libraryPath: boot.library.libraryPath }));
  const saved = await writePolicy(policy);
  assert.equal(saved.response.status, 200, JSON.stringify(saved.body));
  assert.deepEqual(saved.body.readback.selectedPolicy.categories, categories);
  for (const [invalid, code, path] of [
    [{ ...policy, tiers: [policy.tiers[0], { ...policy.tiers[1], order: 10 }] }, "MODELS_ORDER_DUPLICATE", "order"],
    [{ ...policy, categories: [categories[0], categories[1], { ...categories[2], id: "main" }] }, "MODELS_CATEGORY_DUPLICATE", "id"],
    [{ ...policy, tiers: [{ ...policy.tiers[0], category: "ghost" }] }, "ENGINE_MODEL_POLICY_INVALID", "category"],
    [{ ...policy, categories: categories.filter((row) => row.id !== "review") }, "ENGINE_MODEL_POLICY_INVALID", "category"],
    [{ ...policy, categories: categories.filter((row) => row.id !== "main"), tiers: [policy.tiers[0]] }, "ENGINE_MODEL_POLICY_INVALID", "ceiling"],
    [{ ...policy, tiers: [{ ...policy.tiers[0], runner: "Not A Name" }] }, "MODELS_TIERS_INVALID", "runner"],
    [{ ...policy, tiers: [{ ...policy.tiers[0], runner: "claude-code" }] }, "ENGINE_MODEL_POLICY_INVALID", "runner"],
  ]) {
    const refused = await writePolicy(invalid);
    assert.equal(refused.response.status, 409);
    assert.equal(refused.body.reasonCode, code, JSON.stringify(refused.body));
    assert.match(JSON.stringify(refused.body), new RegExp(path));
    const unchanged = await request(url, "/api/model-policy?host=codex", readOptions(boot.token));
    assert.deepEqual(unchanged.body.selectedPolicy, saved.body.readback.selectedPolicy, "invalid whole policy cannot partially replace stored tables");
  }
  const untokened = await request(url, "/api/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: "models.tiers", value: "[]" }) });
  assert.equal(untokened.response.status, 403);
  assert.equal(untokened.body.reasonCode, "PORTAL_TOKEN_REQUIRED");

});



// STORY-373's host probe lost its page control with the dispatch surface (TCRN-CROSS-STORY-467 R3),
// and TCRN-CROSS-STORY-482 R4 removed the route that was left without a page (problem list #29(2)).
// The verb is not retired: it stays in the engine's catalog for a caller that runs it directly.
test("STORY-482 R4: the host probe route is gone while the host-probe verb stays in the catalog", async (t) => {
  const fixture = await scratch("tcrn-portal-host-probe-", "TCRN-PORTAL-HOST-PROBE");
  const { child, url } = await startPortal(fixture);
  t.after(async () => { child.kill(); await rm(fixture.base, { recursive: true, force: true }); });
  const { boot } = await readBoot(url);
  const probe = await request(url, RETIRED_ROUTES.hostProbe, writeOptions(boot.token, "POST", { host: "claude-code", model: "does-not-exist" }));
  assert.equal(probe.response.status, 404);
  assert.equal(probe.body.reasonCode, "PORTAL_ROUTE_UNKNOWN");
  const commands = await request(url, "/api/commands", readOptions(boot.token));
  assert.ok(commands.body.commands.some((entry) => entry.name === "host-probe"), "the host-probe verb stays in the catalog");
});
