// SPDX-License-Identifier: Apache-2.0
// Tests in this file run sequentially; Node isolates each file in a process.
import { CLI, R46_AT, RETIRED_PERSONA_ACTIONS, RETIRED_ROUTES, TEST_ACTOR, assert, cli, ensureProjectCoordination, execFileAsync, forgeOwnStream, join, managedSection, mkdir, mkdtemp, normalizedSection, portalRoot, readBoot, readFile, readOptions, realpath, request, rm, scratch, sectionDigest, spawn, startPortal, startupRefusal, test, tmpdir, withoutSource, writeFile, writeOptions } from './portal-support.mjs';


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


test("AGENTS.md read/write is allow-listed and reconciliation reports line-level findings", async (t) => {
  const fixture = await scratch("tcrn-portal-agents-", "TCRN-PORTAL-AGENTS");
  const { child, url } = await startPortal(fixture);
  t.after(async () => { child.kill(); await rm(fixture.base, { recursive: true, force: true }); });
  const { boot } = await readBoot(url);
  const text = "# rules\n\nSet retrieval.tau before close.\n";
  const written = await request(url, "/api/agents-md", writeOptions(boot.token, "PUT", { file: "AGENTS.md", text }));
  assert.equal(written.body.reasonCode, "PORTAL_AGENTS_MD_WRITTEN");
  assert.equal(written.body.matches, true);
  assert.equal(written.body.saved, true);
  // TCRN-CROSS-SUB-338: a save judges and renders nothing.
  assert.equal(Object.hasOwn(written.body, "render"), false);
  assert.equal(written.body.text, text);
  assert.equal(await readFile(join(fixture.proseRoot, "AGENTS.md"), "utf8"), written.body.text);
  const green = await request(url, "/api/agents-md/reconcile", readOptions(boot.token));
  assert.equal(green.body.ok, true);
  assert.equal(green.body.findings.length, 0);

  await writeFile(join(fixture.proseRoot, "AGENTS.md"), `${text}\nAlso set retrieval.retiredKey.\n`, "utf8");
  const red = await request(url, "/api/agents-md/reconcile", readOptions(boot.token));
  assert.equal(red.body.ok, false);
  assert.equal(red.body.findings[0].kind, "unregistered");
  assert.equal(red.body.findings[0].line, 5);

  const escapedRead = await request(url, "/api/agents-md?file=" + encodeURIComponent("../AGENTS.md"), readOptions(boot.token));
  assert.equal(escapedRead.response.status, 404);
  assert.equal(escapedRead.body.reasonCode, "PORTAL_PATH_ESCAPE");
  const escapedWrite = await request(url, "/api/agents-md", writeOptions(boot.token, "PUT", { file: "../AGENTS.md", text: "no" }));
  assert.equal(escapedWrite.response.status, 404);
  assert.equal(escapedWrite.body.reasonCode, "PORTAL_PATH_ESCAPE");
});


// TCRN-CROSS-SUB-338 (STORY-483 R3; MIN-235 D4): a save writes the file and judges it through
// rule-list; it renders no managed section and writes nothing to the library.
test("AGENTS.md save writes the file, judges it without rendering, and reads it back", async (t) => {
  const fixture = await scratch("tcrn-portal-conservation-prose-", "TCRN-PORTAL-CONSERVATION-PROSE");
  const { child, url } = await startPortal(fixture);
  t.after(async () => { child.kill(); await rm(fixture.base, { recursive: true, force: true }); });
  const { boot } = await readBoot(url);
  const text = "# AGENTS.md\n\nOwner actions stay parked.\n";
  const version = (await cli(["status", "--workspace", fixture.workspace], fixture.deviceEnv)).version;
  const written = await request(url, "/api/agents-md", writeOptions(boot.token, "PUT", { file: "AGENTS.md", text }));
  assert.equal(written.body.reasonCode, "PORTAL_AGENTS_MD_WRITTEN");
  assert.equal(written.body.matches, true);
  assert.equal(Object.hasOwn(written.body, "render"), false);
  // Every rule the engine lists, in its order, reads disabled.
  const engineRules = (await cli(["rule-list", "--project", fixture.proseRoot], fixture.deviceEnv)).rules.map((rule) => rule.id);
  assert.ok(engineRules.includes("batch"), "the engine lists its built-in rules");
  assert.deepEqual(written.body.rules.map((rule) => [rule.id, rule.state]), engineRules.map((id) => [id, "disabled"]));
  assert.deepEqual(written.body.pending, []);
  assert.equal(written.body.text, text, "no managed section was rendered into the saved text");
  assert.equal((await cli(["status", "--workspace", fixture.workspace], fixture.deviceEnv)).version, version, "a save writes nothing to the library");
  assert.equal(await readFile(join(fixture.proseRoot, "AGENTS.md"), "utf8"), written.body.text);
  const readback = await request(url, "/api/agents-md", readOptions(boot.token));
  assert.equal(readback.body.text, written.body.text);
  assert.equal(readback.body.path, join(fixture.proseRoot, "AGENTS.md"));
  const escapedRead = await request(url, "/api/agents-md?file=" + encodeURIComponent("../AGENTS.md"), readOptions(boot.token));
  assert.equal(escapedRead.response.status, 404);
  assert.equal(escapedRead.body.reasonCode, "PORTAL_PATH_ESCAPE");
  const escapedWrite = await request(url, "/api/agents-md", writeOptions(boot.token, "PUT", { file: "../AGENTS.md", text: "no" }));
  assert.equal(escapedWrite.response.status, 404);
  assert.equal(escapedWrite.body.reasonCode, "PORTAL_PATH_ESCAPE");
});


test("INIT-053 AC2: batch enabled at v2 reads update-available at the route, and neither the read nor a save writes AGENTS.md", async (t) => {
  const fixture = await scratch("tcrn-portal-rule-v2-", "TCRN-PORTAL-RULE-V2");
  let portal = null;
  t.after(async () => { portal?.child.kill(); await rm(fixture.base, { recursive: true, force: true }); });
  const agentsPath = join(fixture.proseRoot, "AGENTS.md");
  await cli(["rule-enable", "--project", fixture.proseRoot, "--id", "batch", "--at", "2026-08-11T15:20:00Z", "--actor", "agent:test"], { ...fixture.deviceEnv, EINZBERN_SURFACE: "atelier" });
  const enabled = await readFile(agentsPath, "utf8");
  const v3 = managedSection(enabled, "rule:batch");
  assert.equal(sectionDigest(v3.body), v3.digest, "the digest taken here is the engine's");
  const v2Body = normalizedSection(await readFile(join(portalRoot, "..", "tests", "fixtures", "rules", "batch-v2.zh.md"), "utf8"));
  assert.notEqual(v2Body, normalizedSection(v3.body));
  const v2Digest = sectionDigest(v2Body);
  await writeFile(agentsPath, enabled.replace(v3.raw, `<!-- einzbern:section id=rule:batch rev=${v3.rev} digest=${v2Digest} -->\n${v2Body}<!-- einzbern:section-end id=rule:batch -->\n`), "utf8");
  let forged = 0;
  await forgeOwnStream(fixture.workspace, (events) => events.map((event) => {
    const record = event.payload?.operation === "config.record.set" ? event.payload.record : null;
    if (record?.collection === "rule" && record.key === "batch") { record.value.version = 2; forged += 1; }
    if (record?.collection === "managed-section" && record.key === "AGENTS.md#rule:batch") { record.value.digest = v2Digest; forged += 1; }
    return { occurredAt: event.occurredAt, payload: event.payload, clock: event.clock };
  }));
  assert.equal(forged, 2, "the rule's record and its section's record");
  const v2File = await readFile(agentsPath, "utf8");

  portal = await startPortal(fixture);
  const { url } = portal;
  const { boot } = await readBoot(url);
  const listed = await request(url, "/api/rules", readOptions(boot.token));
  assert.equal(listed.response.status, 200);
  assert.deepEqual(withoutSource(listed.body.rules.find((rule) => rule.id === "batch")), { id: "batch", version: 3, recordedVersion: 2, fileVersion: 1, section: "rule:batch", state: "update-available" });
  assert.deepEqual(listed.body.pending, []);
  assert.equal(await readFile(agentsPath, "utf8"), v2File, "GET /api/rules writes nothing");

  // Saving those bytes is judged and renders nothing, so the v2 section stays as it is.
  const saved = await request(url, "/api/agents-md", writeOptions(boot.token, "PUT", { file: "AGENTS.md", text: v2File }));
  assert.equal(saved.body.reasonCode, "PORTAL_AGENTS_MD_WRITTEN");
  assert.equal(saved.body.rules.find((rule) => rule.id === "batch").state, "update-available");
  assert.deepEqual(saved.body.pending, []);
  assert.equal(await readFile(agentsPath, "utf8"), v2File);
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


// TCRN-CROSS-SUB-310 R17 (MIN-238 D1, D5): no budget bounds the sum of a crest's card bodies, and
// knowledge.aggregateBytes, the setting that set one, is retired. Its label, its description and its
// concept explanation -- the copy TCRN-CROSS-SUB-412 wrote for the live-body count -- leave all five
// languages, and no text there still names the key.
test("SUB-310 R17 (MIN-238 D1): the retired knowledge total setting has no copy left, in any language", async () => {
  const sandbox = {};
  new Function("window", await readFile(join(portalRoot, "locales.js"), "utf8"))(sandbox);
  assert.deepEqual(Object.keys(sandbox.PORTAL_LOCALES).sort(), ["en", "fr", "ja", "ko", "zh-CN"]);
  for (const [locale, table] of Object.entries(sandbox.PORTAL_LOCALES)) {
    for (const key of ["setting.knowledge.aggregateBytes.label", "setting.knowledge.aggregateBytes.description", "concept.setting.knowledge.aggregateBytes"]) {
      assert.equal(Object.hasOwn(table, key), false, `${locale} ${key}`);
    }
    assert.deepEqual(Object.entries(table).filter(([key, text]) => `${key} ${text}`.includes("knowledge.aggregateBytes")).map(([key]) => key), [], locale);
  }
});


test("fresh coordination's own registration boots and switches without a prose output", async t => {
  const fixture = await scratch("portal-fresh-coordination-", "COORDINATION-LIFECYCLE");
  const coordination = await ensureProjectCoordination(fixture.workspace, "2026-10-08T10:00:00Z", fixture.deviceEnv.EINZBERN_HOME);
  const { child, url } = await startPortal({ ...fixture, library: coordination.path });
  t.after(async () => { if (child.exitCode === null) { const exited = new Promise(resolve => child.once("exit", resolve)); child.kill(); await exited; } await rm(fixture.base, { recursive: true, force: true }); });
  const { boot } = await readBoot(url);
  assert.equal(boot.proseRoot, null);
  assert.equal(boot.library.chain.role, "coordination");
  const prose = await request(url, "/api/agents-md", readOptions(boot.token));
  assert.equal(prose.body.outputBindingStatus, "unconfigured");
  const denied = await request(url, "/api/agents-md", writeOptions(boot.token, "PUT", { text: "must not enter library" }));
  assert.equal(denied.body.ok, false);
  await assert.rejects(readFile(join(coordination.path, "AGENTS.md")), { code: "ENOENT" });
  const project = await request(url, "/api/library", writeOptions(boot.token, "POST", { library: fixture.workspace }));
  assert.equal(project.body.proseRoot, fixture.proseRoot);
  const back = await request(url, "/api/library", writeOptions(boot.token, "POST", { library: coordination.path }));
  assert.equal(back.body.ok, true);
  assert.equal(back.body.proseRoot, null);
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
