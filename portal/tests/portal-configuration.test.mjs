// SPDX-License-Identifier: Apache-2.0
// Tests in this file run sequentially; Node isolates each file in a process.
import { R46_AT, R47_COORDINATION_KEYS, RETIRED_PERSONA_ACTIONS, TEST_ACTOR, appendHistoricalAttestationEnable, asDevice, assert, cli, cliRefusal, ensureProjectCoordination, execFileAsync, forgeOwnStream, join, managedSection, mkdir, mkdtemp, normalizedSection, portalRoot, readBoot, readFile, readOptions, realpath, registeredLibrary, request, rm, scratch, sectionDigest, startPortal, test, tmpdir, unordered, unregisterLibrary, withoutSource, writeFile, writeOptions } from "./portal-support.mjs";



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
  assert.equal(initial.body.selectedPolicy, null);
  assert.deepEqual(initial.body.onboarding.categories.map(row => row.id), ["flagship", "main", "economy"]);
  assert.ok(initial.body.onboarding.tiers.every(row => row.model === "" && row.effort === ""));
  assert.deepEqual(initial.body.peerReadiness.missingCategories, ["main", "economy"]);
  assert.equal(initial.body.peerReadiness.ready, false);
  const reread = await request(url, "/api/model-policy?host=codex", readOptions(boot.token));
  assert.equal(reread.body.storeRevision, initial.body.storeRevision, "onboarding reads never save a policy");


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
  assert.deepEqual(saved.body.readback.peerReadiness.missingCategories, ["main"]);
  assert.equal(saved.body.readback.peerReadiness.ready, false, "an economy binding cannot replace main");
  const complete = {
    categories: [{ order: 20, id: "main", name: "Main", description: "Owner order" }, { order: 40, id: "economy", name: "Economy", description: "" }],
    tiers: [{ order: 30, category: "main", runner: "codex", model: "main-model", effort: "high", note: "Owner tier" }, { order: 60, category: "economy", runner: "codex", model: "economy-model", effort: "low", note: "" }],
    escalation: { enabled: true, threshold: 2, ceiling: "main" },
  };
  const set = async (next) => request(url, "/api/model-policy", writeOptions(boot.token, "POST", { host: "codex", policy: next, decidedIn: `${minutesId}#D1`, ...writeScope }));
  const configured = await set(complete);
  assert.equal(configured.response.status, 200);
  const catalog = configured.body.readback;
  assert.equal(catalog.peerReadiness.ready, true, "main/economy suffice without any flagship binding");
  assert.deepEqual(catalog.onboarding.categories.slice(0, 2), complete.categories, "repair preserves existing category order and values");
  assert.deepEqual(catalog.onboarding.tiers.slice(0, 2), complete.tiers, "repair preserves existing tiers");
  assert.equal(catalog.onboarding.categories[2].id, "flagship");
  assert.equal(catalog.onboarding.tiers[2].model, "");
  assert.deepEqual(catalog.onboarding.escalation, complete.escalation, "offered flagship does not silently become the escalation ceiling");
  const offered = await set(catalog.onboarding);
  assert.equal(offered.response.status, 200);
  assert.equal(offered.body.readback.peerReadiness.ready, true, "explicitly saving an unbound optional flagship remains ready");
  const invalidCeiling = await set({ ...catalog.onboarding, escalation: { ...complete.escalation, ceiling: "flagship" } });
  assert.equal(invalidCeiling.response.status, 200);
  assert.equal(invalidCeiling.body.readback.peerReadiness.ready, false);
  assert.equal(invalidCeiling.body.readback.peerReadiness.invalidCeiling, "flagship", "empty flagship cannot count as a usable escalation ceiling");
  for (const host of ["claude-code", "dsh", "dot"]) {
    const other = await request(url, `/api/model-policy?host=${host}`, readOptions(boot.token));
    assert.equal(other.response.status, 200);
    assert.equal(other.body.peerReadiness.applicable, false, `${host} does not acquire Codex peer requirements`);
  }

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



// TCRN-CROSS-SUB-409 (TCRN-CROSS-STORY-508 R5; contract C-R14-1): both settings routes pass every
// catalog row on with its shape, group and order, as the engine wrote them; the page lays itself out
// from those three and keeps no grouping of its own.
test("SUB-409 (STORY-508 R5): the settings routes carry every row's shape, group and order from both catalogs", async (t) => {
  const fixture = await scratch("tcrn-portal-layout-", "TCRN-PORTAL-LAYOUT");
  const { child, url } = await startPortal(fixture);
  t.after(async () => { child.kill(); await rm(fixture.base, { recursive: true, force: true }); });
  const { boot } = await readBoot(url);
  const layout = (rows) => rows.map(({ key, layer, shape, group, order }) => ({ key, layer, shape, group, order }));
  const project = await request(url, "/api/settings", readOptions(boot.token));
  assert.deepEqual(layout(project.body.settings), layout((await cli(["settings-catalog", "--workspace", fixture.workspace], fixture.deviceEnv)).settings));
  assert.deepEqual(project.body.settings.filter((row) => row.shape === "collection").map((row) => row.key).sort(), ["models.category", "models.tiers"]);
  const policy = project.body.settings.find(row => row.key === "work.contentPolicy");
  assert.deepEqual([policy?.shape, policy?.group, policy?.order], ["scalar", "general", 22], "one policy object is not a collection table");
  assert.ok(project.body.settings.every((row) => ["project", "library"].includes(row.layer) && typeof row.group === "string" && Number.isSafeInteger(row.order) && row.order > 0));
  const device = await request(url, "/api/machine-settings", readOptions(boot.token));
  assert.deepEqual(layout(device.body.settings), layout((await cli(["machine-settings-catalog"], { ...fixture.deviceEnv, HOME: fixture.home })).settings));
  assert.ok(device.body.settings.every((row) => row.layer === "device" && row.shape === "scalar"));
  // An order is unique within its group across both catalogs, so a group has one display order.
  const rows = [...project.body.settings, ...device.body.settings];
  for (const group of new Set(rows.map((row) => row.group))) {
    const orders = rows.filter((row) => row.group === group).map((row) => row.order);
    assert.equal(new Set(orders).size, orders.length, `${group}: every order is its own`);
  }
});



test("STORY-484 variable routes write, read back and render safe values while withholding secrets", async (t) => {
  const fixture = await scratch("tcrn-portal-variables-", "TCRN-PORTAL-VARIABLES");
  const { child, url } = await startPortal(fixture);
  t.after(async () => { child.kill(); await rm(fixture.base, { recursive: true, force: true }); });
  const { boot } = await readBoot(url);

  const created = await request(url, "/api/variables", writeOptions(boot.token, "POST", {
    name: "deploy.host", type: "string", value: "build.example.com", description: "Build endpoint", exports: ["agents"],
  }));
  assert.equal(created.response.status, 200);
  assert.equal(created.body.reasonCode, "VARIABLE_WRITE_COMMITTED");
  assert.equal(created.body.readback.source.projectId, fixture.projectId);
  assert.deepEqual(withoutSource(created.body.readback), { name: "deploy.host", type: "string", value: "build.example.com", description: "Build endpoint", exports: ["agents"] });
  assert.deepEqual(created.body.variables, [created.body.readback]);
  assert.equal(created.body.render.reasonCode, "AGENTS_RENDERED");
  assert.match(await readFile(join(fixture.proseRoot, "AGENTS.md"), "utf8"), /deploy\.host.*build\.example\.com/u);

  const updated = await request(url, "/api/variables", writeOptions(boot.token, "POST", {
    name: "deploy.host", type: "string", value: "stage.example.com", description: "Staging endpoint", exports: ["agents"],
  }));
  assert.equal(updated.response.status, 200);
  assert.equal(updated.body.readback.value, "stage.example.com");
  assert.match(await readFile(join(fixture.proseRoot, "AGENTS.md"), "utf8"), /deploy\.host.*stage\.example\.com/u);

  const secret = "sk-proj-0123456789abcdef";
  const refused = await request(url, "/api/variables", writeOptions(boot.token, "POST", {
    name: "api.key", type: "string", value: secret,
  }));
  assert.equal(refused.response.status, 409);
  assert.equal(refused.body.reasonCode, "VARIABLE_SECRET_SHAPED");
  assert.doesNotMatch(JSON.stringify(refused.body), /sk-proj-0123456789abcdef/u, "secret-shaped input must not be echoed in the response");
  assert.equal((await request(url, "/api/variables", readOptions(boot.token))).body.variables.length, 1);

  const removed = await request(url, "/api/variables", writeOptions(boot.token, "DELETE", { name: "deploy.host" }));
  assert.equal(removed.response.status, 200);
  assert.equal(removed.body.reasonCode, "VARIABLE_WRITE_COMMITTED");
  assert.equal(removed.body.readback, null);
  assert.deepEqual(removed.body.variables, []);
  assert.doesNotMatch(await readFile(join(fixture.proseRoot, "AGENTS.md"), "utf8"), /deploy\.host/u);
});



test("STORY-485: Atelier edits gate declarations and reads each library's latest cached gate run", async (t) => {
  const fixture = await scratch("tcrn-portal-gates-", "TCRN-PORTAL-GATES");
  const { child, url } = await startPortal(fixture);
  t.after(async () => { child.kill(); await rm(fixture.base, { recursive: true, force: true }); });
  const { boot } = await readBoot(url);
  const gatesNow = async () => (await request(url, "/api/gates", readOptions(boot.token))).body;
  const latestNow = async () => (await request(url, "/api/gates/last-run", readOptions(boot.token))).body;
  assert.deepEqual((await gatesNow()).gates, []);

  const created = await request(url, "/api/gates", writeOptions(boot.token, "POST", {
    name: "portal", command: ["pnpm", "verify:links"], root: ".", covers: ["portal/**", "docs/**"],
    enabled: true, required: true, releaseOnly: false,
  }));
  assert.equal(created.response.status, 200);
  assert.deepEqual(created.body.gate, { name: "portal", command: ["pnpm", "verify:links"], root: ".", covers: ["portal/**", "docs/**"], enabled: true, required: true, releaseOnly: false });
  assert.deepEqual((await gatesNow()).gates, [created.body.gate]);

  const updated = await request(url, "/api/gates", writeOptions(boot.token, "POST", {
    name: "portal", command: ["pnpm", "verify:portal"], root: "portal", covers: ["portal/**"],
    enabled: false, required: false, releaseOnly: true,
  }));
  assert.equal(updated.response.status, 200);
  assert.equal(updated.body.gate.enabled, false);
  assert.equal(updated.body.gate.required, false);
  assert.equal(updated.body.gate.releaseOnly, true);
  assert.deepEqual(updated.body.gate.covers, ["portal/**"]);
  assert.equal((await latestNow()).run, null);

  const writeRun = async (libraryId, runId, at, gateName, ok) => {
    const directory = join(fixture.deviceEnv.EINZBERN_HOME, "cache", libraryId.replace(":", "-"), "gate-runs");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `${runId}.json`), JSON.stringify({
      schemaVersion: "einzbern.gate-run.v1", runId, libraryId, projectId: libraryId === boot.library.libraryId ? fixture.projectId : fixture.second.projectId, workIds: [], at, release: false, base: null,
      treeDigest: `tree-${runId}`, declarationsDigest: `declarations-${runId}`, trees: [],
      gates: [{ name: gateName, root: ".", required: true, matched: [], matchedWorkIds: [], ok, exitCode: ok ? 0 : 1, signal: null, timedOut: false, outputFile: `${runId}/1-${gateName}.log`, outputBytes: 0, truncated: false }],
      reds: ok ? [] : [gateName],
    }));
  };
  await writeRun(boot.library.libraryId, "first-run", "2026-08-11T16:00:00Z", "portal", false);
  await writeRun(boot.library.libraryId, "latest-run", "2026-08-11T17:00:00Z", "portal", true);
  const latest = await latestNow();
  assert.equal(latest.reasonCode, "PORTAL_GATE_RUN_READY");
  assert.equal(latest.run.runId, "latest-run");
  assert.deepEqual(latest.run.reds, []);

  const second = await cli(["status", "--workspace", fixture.second.library], fixture.deviceEnv);
  await writeRun(second.workspaceId, "second-library-run", "2026-08-11T18:00:00Z", "second", false);
  const switched = await request(url, "/api/library", writeOptions(boot.token, "POST", { library: fixture.second.project }));
  assert.equal(switched.response.status, 200);
  assert.equal((await latestNow()).run.runId, "second-library-run");

  const back = await request(url, "/api/library", writeOptions(boot.token, "POST", { library: fixture.proseRoot }));
  assert.equal(back.response.status, 200);
  const removed = await request(url, "/api/gates", writeOptions(boot.token, "DELETE", { name: "portal" }));
  assert.equal(removed.response.status, 200);
  assert.deepEqual(removed.body.gates, []);
  assert.deepEqual((await gatesNow()).gates, []);
});



// TCRN-CROSS-SUB-410 (TCRN-CROSS-STORY-508 R7; contract C-R14-5): the variable, rule and gate routes
// pass an order to the engine as it was sent, so the engine records it or says what is wrong with it,
// and each read-back carries it. An empty order is none: variable-set then writes a variable without
// one, and rule-enable and gates-config-set keep the order the record holds.
test("SUB-410 (STORY-508 R7): the variable, rule and gate routes write an order through the engine and read it back", async (t) => {
  const fixture = await scratch("tcrn-portal-orders-", "TCRN-PORTAL-ORDERS");
  const { child, url } = await startPortal(fixture);
  t.after(async () => { child.kill(); await rm(fixture.base, { recursive: true, force: true }); });
  const { boot } = await readBoot(url);
  const post = (path, body) => request(url, path, writeOptions(boot.token, "POST", body));

  const variable = await post("/api/variables", { name: "deploy.host", type: "string", value: "build.example.com", order: "3" });
  assert.equal(variable.response.status, 200);
  assert.equal(variable.body.readback.source.projectId, fixture.projectId);
  assert.deepEqual(withoutSource(variable.body.readback), { name: "deploy.host", type: "string", value: "build.example.com", description: "", exports: [], order: 3 });
  const unordered = await post("/api/variables", { name: "deploy.host", type: "string", value: "build.example.com", order: "" });
  assert.equal(Object.hasOwn(unordered.body.readback, "order"), false, "variable-set writes the whole record, so no order is none");
  const malformed = await post("/api/variables", { name: "deploy.host", type: "string", value: "x", order: "0" });
  assert.equal(malformed.response.status, 409);
  assert.equal(malformed.body.reasonCode, "CLI_ARGUMENT_MALFORMED");
  // The variable write rendered the system variables section too; its heading models.escalation names
  // the family of the three escalation keys, so the Rules page's check does not count it as a claim.
  const reconciled = await request(url, "/api/agents-md/reconcile", readOptions(boot.token));
  assert.match(await readFile(join(fixture.proseRoot, "AGENTS.md"), "utf8"), /execution-policy-resolve/u, "shared output names the runtime policy resolver instead of freezing a host choice");
  assert.deepEqual(reconciled.body.findings.filter((row) => row.key.startsWith("models.")), []);

  const rule = await post("/api/rules/batch", { action: "enable", order: 2 });
  assert.equal(rule.body.reasonCode, "RULE_ENABLED");
  assert.equal(rule.body.rules.find((entry) => entry.id === "batch").order, 2);
  const kept = await post("/api/rules/batch", { action: "enable" });
  assert.equal(kept.body.rules.find((entry) => entry.id === "batch").order, 2, "an enable without an order keeps the recorded one");
  const disabled = await post("/api/rules/batch", { action: "disable", order: 7 });
  assert.equal(disabled.body.reasonCode, "RULE_DISABLED");
  assert.equal(disabled.body.rules.find((entry) => entry.id === "batch").order, 2, "a disable carries no order and keeps the recorded one");

  const gate = { name: "unit", command: ["node", "--version"], root: ".", covers: ["**"], enabled: true, required: true, releaseOnly: false };
  const declared = await post("/api/gates", { ...gate, order: 4 });
  assert.equal(declared.response.status, 200);
  assert.equal(declared.body.gate.order, 4);
  assert.equal((await post("/api/gates", gate)).body.gate.order, 4, "a redeclaration without an order keeps the recorded one");
  const refused = await post("/api/gates", { ...gate, order: "0" });
  assert.equal(refused.response.status, 409);
  assert.equal(refused.body.reasonCode, "CLI_ARGUMENT_MALFORMED");
  assert.equal((await post("/api/gates", { ...gate, order: { value: 1 } })).body.reasonCode, "PORTAL_GATE_INPUT_INVALID");
});



// TCRN-CROSS-SUB-422 (TCRN-CROSS-STORY-513 AC1, AC2; MIN-238 D2): the CLI refuses a model's rule and
// gate writes, and Atelier's routes, which run them with EINZBERN_SURFACE=atelier, write them. The
// portal is started from a shell whose surface is not Atelier's, so the surface its writes carry is
// its own.
test("SUB-422 (STORY-513 AC2): Atelier switches a rule and saves and deletes a gate that the CLI refuses a model", async (t) => {
  const fixture = await scratch("tcrn-portal-write-guard-", "TCRN-PORTAL-WRITE-GUARD");
  const { child, url } = await startPortal({ ...fixture, env: { EINZBERN_SURFACE: "" } });
  t.after(async () => { child.kill(); await rm(fixture.base, { recursive: true, force: true }); });
  const { boot } = await readBoot(url);
  const send = (path, method, body) => request(url, path, writeOptions(boot.token, method, body));
  const libraryVersion = async () => (await cli(["status", "--workspace", fixture.workspace], fixture.deviceEnv)).version;
  const before = await libraryVersion();
  const model = { ...fixture.deviceEnv, EINZBERN_SURFACE: "" };
  const common = ["--at", "2026-08-11T15:40:00Z", "--actor", "agent:test"];
  for (const args of [
    ["rule-enable", "--project", fixture.proseRoot, "--id", "batch", ...common],
    ["rule-disable", "--project", fixture.proseRoot, "--id", "batch", ...common],
    ["gates-config-set", "--workspace", fixture.workspace, "--name", "unit", "--command", JSON.stringify(["node", "--version"]), ...common],
    ["gates-config-remove", "--workspace", fixture.workspace, "--name", "unit", ...common],
  ]) {
    const refused = await cliRefusal(args, model);
    assert.deepEqual([refused.reasonCode, refused.remedy], ["MODEL_WRITE_REFUSED", "change it in Atelier, or cite the Owner's decision with --decided-in minutes:<id>#D<n>"], args[0]);
  }
  assert.equal(await libraryVersion(), before, "no refused write appended an event");

  const enabled = await send("/api/rules/batch", "POST", { action: "enable" });
  assert.deepEqual([enabled.response.status, enabled.body.reasonCode], [200, "RULE_ENABLED"]);
  const disabled = await send("/api/rules/batch", "POST", { action: "disable" });
  assert.deepEqual([disabled.response.status, disabled.body.reasonCode], [200, "RULE_DISABLED"]);
  const gate = { name: "unit", command: ["node", "--version"], root: ".", covers: ["**"], enabled: true, required: true, releaseOnly: false };
  const saved = await send("/api/gates", "POST", gate);
  assert.deepEqual([saved.response.status, saved.body.gate], [200, gate]);
  const deleted = await send("/api/gates", "DELETE", { name: "unit" });
  assert.deepEqual([deleted.response.status, deleted.body.gates], [200, []]);
  assert.ok(await libraryVersion() > before, "Atelier's writes are recorded");
});



// TCRN-CROSS-SUB-338 (STORY-483 AC3): a project that enabled batch processing at v1, read by an
// engine that ships v3. No verb records a rule at another version than the one this engine
// ships, so the fixture is left the way an older engine would have left it: this engine enables
// batch, and then the section in AGENTS.md (its text and digest), the rule's recorded version and
// the section record's digest are put back to v1, the last two through the test forger. The
// section's rev is its own revision, the first either way.
test("SUB-338 (STORY-483 AC3): batch enabled at v1 reads update-available at the route, and neither the read nor a save writes AGENTS.md", async (t) => {
  const fixture = await scratch("tcrn-portal-rule-v1-", "TCRN-PORTAL-RULE-V1");
  let portal = null;
  t.after(async () => { portal?.child.kill(); await rm(fixture.base, { recursive: true, force: true }); });
  const agentsPath = join(fixture.proseRoot, "AGENTS.md");
  await cli(["rule-enable", "--project", fixture.proseRoot, "--id", "batch", "--at", "2026-08-11T15:20:00Z", "--actor", "agent:test"], { ...fixture.deviceEnv, EINZBERN_SURFACE: "atelier" });
  const enabled = await readFile(agentsPath, "utf8");
  const v3 = managedSection(enabled, "rule:batch");
  assert.equal(sectionDigest(v3.body), v3.digest, "the digest taken here is the engine's");
  const v1Body = normalizedSection(await readFile(join(portalRoot, "..", "tests", "fixtures", "rules", "batch-v1.zh.md"), "utf8"));
  assert.notEqual(v1Body, normalizedSection(v3.body));
  const v1Digest = sectionDigest(v1Body);
  await writeFile(agentsPath, enabled.replace(v3.raw, `<!-- einzbern:section id=rule:batch rev=${v3.rev} digest=${v1Digest} -->\n${v1Body}<!-- einzbern:section-end id=rule:batch -->\n`), "utf8");
  let forged = 0;
  await forgeOwnStream(fixture.workspace, (events) => events.map((event) => {
    const record = event.payload?.operation === "config.record.set" ? event.payload.record : null;
    if (record?.collection === "rule" && record.key === "batch") { record.value.version = 1; forged += 1; }
    if (record?.collection === "managed-section" && record.key === "AGENTS.md#rule:batch") { record.value.digest = v1Digest; forged += 1; }
    return { occurredAt: event.occurredAt, payload: event.payload, clock: event.clock };
  }));
  assert.equal(forged, 2, "the rule's record and its section's record");
  const v1File = await readFile(agentsPath, "utf8");

  portal = await startPortal(fixture);
  const { url } = portal;
  const { boot } = await readBoot(url);
  const listed = await request(url, "/api/rules", readOptions(boot.token));
  assert.equal(listed.response.status, 200);
  assert.deepEqual(withoutSource(listed.body.rules.find((rule) => rule.id === "batch")), { id: "batch", version: 3, recordedVersion: 1, fileVersion: 1, section: "rule:batch", state: "update-available" });
  assert.deepEqual(listed.body.pending, []);
  assert.equal(await readFile(agentsPath, "utf8"), v1File, "GET /api/rules writes nothing");

  // Saving those bytes is judged and renders nothing, so the v1 section stays as it is.
  const saved = await request(url, "/api/agents-md", writeOptions(boot.token, "PUT", { file: "AGENTS.md", text: v1File }));
  assert.equal(saved.body.reasonCode, "PORTAL_AGENTS_MD_WRITTEN");
  assert.equal(saved.body.rules.find((rule) => rule.id === "batch").state, "update-available");
  assert.deepEqual(saved.body.pending, []);
  assert.equal(await readFile(agentsPath, "utf8"), v1File);
});



test("STORY-370 the retired identity surface is absent while execution settings remain writable", async (t) => {
  const fixture = await scratch("tcrn-portal-conservation-cards-", "TCRN-PORTAL-CONSERVATION-CARDS");
  const { child, url } = await startPortal(fixture);
  t.after(async () => { child.kill(); await rm(fixture.base, { recursive: true, force: true }); });
  const { page, boot } = await readBoot(url);
  // The persona actions went through the execution route, which left with the dispatch-* verbs
  // (TCRN-CROSS-STORY-467 R3): every one of them now reaches no route at all.
  const post = async (payload) => request(url, "/api/execution", writeOptions(boot.token, "POST", payload));
  assert.doesNotMatch(page, /<section[^>]+data-page="entities"/u);
  const override = await post({ action: RETIRED_PERSONA_ACTIONS.override, name: "Verity", fields: { mission: "temporary portal override", role: "reviewer" } });
  assert.equal(override.body.reasonCode, "PORTAL_ROUTE_UNKNOWN");
  const restoreAll = await post({ action: RETIRED_PERSONA_ACTIONS.restore, name: "Verity" });
  assert.equal(restoreAll.body.reasonCode, "PORTAL_ROUTE_UNKNOWN");
  const custom = await post({ action: RETIRED_PERSONA_ACTIONS.set, name: "Portal auditor", role: "reviewer", mission: "Review exact evidence", refusals: "No unsupported claims" });
  assert.equal(custom.body.reasonCode, "PORTAL_ROUTE_UNKNOWN");
  const refused = await post({ action: RETIRED_PERSONA_ACTIONS.remove, name: "Portal auditor" });
  assert.equal(refused.body.reasonCode, "PORTAL_ROUTE_UNKNOWN");
  // execution.subagentPolicy retired with TCRN-CROSS-STORY-484 R3; the concurrency limit stays writable.
  const policy = await request(url, "/api/settings", writeOptions(boot.token, "POST", { key: "execution.maxConcurrentSubagents", value: "2" }));
  assert.equal(policy.body.setting.value, "2");
  const settings = await request(url, "/api/settings", readOptions(boot.token));
  assert.equal(settings.body.settings.some((entry) => /persona/iu.test(entry.key)), false);
});
