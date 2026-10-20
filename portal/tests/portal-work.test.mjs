// SPDX-License-Identifier: Apache-2.0
// Tests in this file run sequentially; Node isolates each file in a process.
import { CLI, LARGE_STORIES, RETIRED_PERSONA_ACTIONS, RETIRED_ROUTES, TEST_ACTOR, appendHistoricalAttestationEnable, appendHistoricalModelSetting, assert, cli, cliRefusal, forgeOwnStream, join, largeLibrary, managedSection, mkdir, mkdtemp, normalizedSection, pageOf, pagedWork, portalRoot, rawRequest, readBoot, readFile, readOptions, realpath, registeredLibrary, request, rm, scratch, scratchHome, sectionDigest, startPortal, startupRefusal, test, tmpdir, unordered, withoutSource, workPagesHarness, writeFile, writeOptions } from './portal-support.mjs';


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


test("SUB-403 (STORY-482 R3): /api/work reads a library larger than one work-list page whole, and never mixes two versions of it", async (t) => {
  const fixture = await scratch("tcrn-portal-large-", "TCRN-PORTAL-LARGE");
  await largeLibrary(fixture);
  const completeLargePage = await cli(["work-list", "--workspace", fixture.workspace, "--limit", "100"], fixture.deviceEnv);
  assert.equal(completeLargePage.records.length, 100, "the new source preserves a complete page past the former byte ceiling");
  const expected = await pagedWork(fixture, 30);
  assert.equal(expected.total, LARGE_STORIES + 2);
  assert.equal(expected.ids.length, expected.total);

  const harness = await workPagesHarness(fixture);
  const { mode, calls } = harness;
  await mode({ mode: "pass", cap: 50 });
  const { child, url } = await startPortal({ ...fixture, env: harness.env });
  t.after(async () => { child.kill(); await rm(fixture.base, { recursive: true, force: true }); });
  const { boot } = await readBoot(url);
  const readWork = async () => (await request(url, "/api/work", readOptions(boot.token))).body;
  const idsOf = (body) => body.records.map((record) => record.id);
  await calls();

  // Read whole: every record, once, in pages of at most 100; the page of 100 the budget refused
  // was asked for again at 50, and the two pages after it were read at once (TCRN-CROSS-SUB-416).
  const whole = await readWork();
  assert.equal(whole.ok, true);
  assert.equal(whole.reasonCode, "PORTAL_WORK_READY");
  assert.deepEqual([whole.workspaceId, whole.version, whole.headEventHash, whole.total], [expected.workspaceId, expected.version, expected.headEventHash, expected.total]);
  assert.equal(new Set(idsOf(whole)).size, whole.records.length, "no record twice");
  assert.deepEqual([...idsOf(whole)].sort(), [...expected.ids].sort());
  const wholeCalls = (await calls()).map(pageOf);
  assert.deepEqual(wholeCalls.slice(0, 2), [["100", "0"], ["50", "0"]]);
  assert.deepEqual(unordered(wholeCalls.slice(2)), [["50", "50"], ["50", "100"]]);

  // The library moves between two pages: the read starts over and answers for the new version.
  await mode({ mode: "move-once", cap: 50 });
  const moved = await readWork();
  const after = await cli(["status", "--workspace", fixture.workspace], fixture.deviceEnv);
  assert.equal(moved.ok, true);
  assert.notEqual(after.version, whole.version, "the wrapper wrote to the library between two pages");
  assert.deepEqual([moved.version, moved.headEventHash, moved.total], [after.version, after.headEventHash, expected.total]);
  assert.deepEqual([...idsOf(moved)].sort(), [...expected.ids].sort());
  // Each read begins with the page of 100 at offset 0; the pages of one read all end before the next read begins.
  const reads = (await calls()).map(pageOf).reduce((runs, page) => {
    if (page[0] === "100" && page[1] === "0") runs.push([]);
    runs.at(-1).push(page);
    return runs;
  }, []);
  assert.deepEqual(reads.map((pages) => [...pages.slice(0, 2), ...unordered(pages.slice(2))]), [
    [["100", "0"], ["50", "0"], ["50", "50"], ["50", "100"]],
    [["100", "0"], ["50", "0"], ["50", "50"], ["50", "100"]],
  ], "the moved read was abandoned and read again from the start");

  // It moves on every read: nothing mixed, a refusal.
  await mode({ mode: "move-always", cap: 50 });
  const unstable = await readWork();
  assert.deepEqual([unstable.ok, unstable.reasonCode, unstable.total, unstable.records], [false, "PORTAL_WORK_READ_FAILED", 0, []]);
  assert.deepEqual([unstable.source.reasonCode, unstable.source.attempts, unstable.source.cause], ["PORTAL_WORK_READ_UNSTABLE", 3, "moved"]);
  await calls();

  // Every page is over the budget: the page shrinks to one record, and then the read is refused.
  await mode("oversized");
  const oversized = await readWork();
  assert.deepEqual([oversized.ok, oversized.reasonCode, oversized.total, oversized.records], [false, "PORTAL_WORK_READ_FAILED", 0, []]);
  assert.equal(oversized.source.reasonCode, "CLI_WORK_LIST_OVERSIZED");
  assert.deepEqual((await calls()).map(({ limit, offset }) => [limit, offset]), [["100", "0"], ["50", "0"], ["25", "0"], ["12", "0"], ["6", "0"], ["3", "0"], ["1", "0"]]);

  // The token gate is unchanged.
  const untokened = await request(url, "/api/work");
  assert.equal(untokened.response.status, 403);
  assert.equal(untokened.body.reasonCode, "PORTAL_TOKEN_REQUIRED");
});


// TCRN-CROSS-SUB-416 (TCRN-CROSS-STORY-510): the pages past the first are read a few at a time,
// and the wrapper holds each for a delay of its own, so they end out of offset order. /api/work
// still answers what the library read page by page answers: the same records in the same order,
// the same total, nothing twice. A page past the first that the budget refuses is halved within
// its own stretch, and one the budget still refuses at one record is the refusal.
test("SUB-416 (STORY-510): /api/work reads the pages past the first a few at a time and answers exactly the serial page-by-page read", async (t) => {
  const bound = Number((await readFile(join(portalRoot, "portal.mjs"), "utf8")).match(/const WORK_PAGE_CONCURRENCY = workReadBudget\("TCRN_PORTAL_WORK_PAGE_CONCURRENCY", (\d+)\);/u)?.[1]);
  assert.ok(bound > 1, "the portal names a concurrency bound above one");
  const fixture = await scratch("tcrn-portal-concurrent-", "TCRN-PORTAL-CONCURRENT");
  await largeLibrary(fixture);
  const serial = await pagedWork(fixture, 30);
  assert.equal(serial.total, LARGE_STORIES + 2);
  const harness = await workPagesHarness(fixture);
  const { mode, calls } = harness;
  const { child, url } = await startPortal({ ...fixture, env: harness.env });
  t.after(async () => { child.kill(); await rm(fixture.base, { recursive: true, force: true }); });
  const { boot } = await readBoot(url);
  const readWork = async () => (await request(url, "/api/work", readOptions(boot.token))).body;
  const assertSerial = (body) => {
    assert.deepEqual([body.ok, body.reasonCode, body.workspaceId, body.version, body.headEventHash, body.total], [true, "PORTAL_WORK_READY", serial.workspaceId, serial.version, serial.headEventHash, serial.total]);
    assert.deepEqual(body.records, serial.records, "the serial read's records, in its order");
    assert.equal(new Set(body.records.map((record) => record.id)).size, body.total, "no record twice");
  };
  await calls();

  // Pages of 12, since the cap refuses 100, 50 and 25: ten stretches past the first page, each held
  // so that the last of every four the portal sends out ends first.
  const delays = {};
  for (let offset = 12; offset < serial.total; offset += 12) delays[offset] = [900, 600, 300, 0][(offset / 12 - 1) % 4];
  await mode({ mode: "delay", cap: 12, delays });
  assertSerial(await readWork());
  const log = await calls();
  assert.deepEqual(log.slice(0, 4).map(pageOf), [["100", "0"], ["50", "0"], ["25", "0"], ["12", "0"]], "the first page is read alone, halved as before");
  const stretches = log.slice(4);
  assert.deepEqual(unordered(stretches.map(pageOf)), Object.keys(delays).map((offset) => ["12", offset]), "each page past the first once, at the size the first page was read at");
  const ended = stretches.map(({ offset }) => Number(offset));
  assert.notDeepEqual(ended, [...ended].sort((left, right) => left - right), "the pages ended out of offset order");
  const outAtOnce = Math.max(...stretches.map((call) => stretches.filter((other) => other.began <= call.began && call.began < other.ended).length));
  assert.ok(outAtOnce > 1 && outAtOnce <= bound, `more than one page and at most ${bound} out at once, not ${outAtOnce}`);

  // Pages of 25, and the page at offset 50 is over the budget until it is 12: its stretch [50, 75)
  // is read as 12, 12 and 1 records, and never reaches into the stretch after it.
  await mode({ mode: "delay", cap: 25, caps: { 50: 12 }, delays: { 25: 300, 75: 150 } });
  assertSerial(await readWork());
  const halved = (await calls()).map(pageOf);
  assert.deepEqual(halved.slice(0, 3), [["100", "0"], ["50", "0"], ["25", "0"]]);
  assert.deepEqual(unordered(halved.slice(3)), [["25", "25"], ["25", "50"], ["12", "50"], ["12", "62"], ["1", "74"], ["25", "75"], ["25", "100"]]);

  // The page at offset 50 is over the budget even at one record: that is the refusal, and nothing
  // mixed is shown.
  await mode({ mode: "delay", cap: 25, caps: { 50: 0 } });
  const refused = await readWork();
  assert.deepEqual([refused.ok, refused.reasonCode, refused.total, refused.records], [false, "PORTAL_WORK_READ_FAILED", 0, []]);
  assert.equal(refused.source.reasonCode, "CLI_WORK_LIST_OVERSIZED");
  const refusedCalls = (await calls()).map(pageOf);
  assert.deepEqual(refusedCalls.filter(([, offset]) => offset === "50"), [["25", "50"], ["12", "50"], ["6", "50"], ["3", "50"], ["1", "50"]], "the page is halved down to one record before it is the refusal");
  assert.deepEqual(refusedCalls.filter(([, offset]) => offset !== "50" && offset !== "0").filter(([limit, offset]) => limit !== "25" || !["25", "75", "100"].includes(offset)), [], "every other page is a whole page at a stretch's start");
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


// STORY-403 replaces the old STORY-366 manual-writing interaction while retaining
// the native CLI/data contract tested by this same integration case.
test("STORY-366: the article endpoint is refused while the native article stays readable through the knowledge index", async (t) => {
  const fixture = await scratch("tcrn-portal-article-", "TCRN-PORTAL-ARTICLE");
  await cli(["project-create", "--workspace", fixture.workspace, "--at", "2026-08-11T15:00:01Z", "--external-key", "PORTAL-ARTICLE-PROJECT", "--name", "Articles"], fixture.deviceEnv);
  await cli(["knowledge-init", "--workspace", fixture.workspace, "--acknowledge-disposable", "true"], fixture.deviceEnv);
  const native = await cli(["knowledge-article-create", "--workspace", fixture.workspace, "--at", "2026-08-11T15:00:01Z", "--path", "portal-article.md", "--category", "architecture", "--title", "Agent article", "--summary", "Agent article summary", "--content", "Agent article body", "--accountable-owner-id", "owner:portal", "--evidence-ids", "evidence:portal-article"], fixture.deviceEnv);
  assert.equal(native.reasonCode, "KNOWLEDGE_ARTICLE_CREATED");
  assert.equal(await readFile(native.path, "utf8").then((text) => text.includes("Agent article body")), true);
  const { child, url } = await startPortal(fixture);
  t.after(async () => { child.kill(); await rm(fixture.base, { recursive: true, force: true }); });
  const { page, boot } = await readBoot(url);
  assert.doesNotMatch(page, /data-page="articles"/u);
  assert.doesNotMatch(page, /article-form|knowledge-article-create/iu);
  assert.match(page, /data-workspace-tab="knowledge"/u);
  const knowledge = await request(url, "/api/knowledge", readOptions(boot.token));
  const article = knowledge.body.records.find((record) => record.subject === "Agent article");
  assert.ok(article, "the native article must remain in the knowledge index");
  assert.deepEqual(article.sourceReferences, ["portal-article.md"]);
  const body = await request(url, `/api/knowledge/body?id=${encodeURIComponent(article.id)}`, readOptions(boot.token));
  assert.equal(body.response.status, 200);
  assert.match(body.body.body, /Source: portal-article\.md/u);
  const refused = await request(url, "/api/knowledge/articles", writeOptions(boot.token, "POST", { title: "Manual article", category: "architecture", content: "must not write" }));
  assert.equal(refused.response.status, 404);
  assert.equal(refused.body.reasonCode, "PORTAL_ROUTE_UNKNOWN");
  // TCRN-CROSS-SUB-425 (MIN-239 D6): the knowledge list answers valid cards by default; a removed card
  // is listed only when a status asks for it, as it is kept, and its body is refused.
  const removed = await cli(["knowledge-remove", "--workspace", fixture.workspace, "--at", "2026-08-11T15:00:02Z", "--id", article.id, "--reason", "invalid",
    "--basis", "the article moved to the design notes", "--actor", "agent:portal-test"], fixture.deviceEnv);
  assert.equal(removed.reasonCode, "KNOWLEDGE_UNIT_REMOVED");
  const valid = await request(url, "/api/knowledge", readOptions(boot.token));
  assert.deepEqual([valid.body.status, valid.body.records.some((record) => record.id === article.id)], ["valid", false]);
  const listedRemoved = await request(url, "/api/knowledge?status=removed", readOptions(boot.token));
  const kept = listedRemoved.body.records.find((record) => record.id === article.id);
  assert.deepEqual([listedRemoved.body.status, kept?.status, kept?.removal.reason, Object.hasOwn(kept ?? {}, "summary")], ["removed", "removed", "invalid", false]);
  assert.equal((await request(url, "/api/knowledge?status=all", readOptions(boot.token))).body.records.some((record) => record.id === article.id), true);
  const removedBody = await request(url, `/api/knowledge/body?id=${encodeURIComponent(article.id)}`, readOptions(boot.token));
  assert.deepEqual([removedBody.response.status, removedBody.body.reasonCode], [409, "KNOWLEDGE_CARD_REMOVED"]);
  const badStatus = await request(url, "/api/knowledge?status=obsolete", readOptions(boot.token));
  assert.deepEqual([badStatus.response.status, badStatus.body.reasonCode], [400, "PORTAL_KNOWLEDGE_STATUS_INVALID"]);
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


// TCRN-CROSS-STORY-482 R3, AC1: the registry's two libraries are listed and can be switched, and
// each one answers with its own status. The second library carries one event of its own, so the
// two statuses differ in more than their ids.
test("STORY-482 AC1: the registry's two libraries can be switched, and each answers with its own status", async (t) => {
  const fixture = await scratch("tcrn-portal-libraries-", "TCRN-PORTAL-LIBRARIES");
  await cli(["settings-set", "--workspace", fixture.second.library, "--at", "2026-08-11T15:01:00Z", "--actor", "agent:test", "--key", "artifact.language", "--value", "zh-CN"], { ...fixture.deviceEnv, EINZBERN_SURFACE: "atelier" });
  const first = await cli(["status", "--workspace", fixture.workspace], fixture.deviceEnv);
  const second = await cli(["status", "--workspace", fixture.second.library], fixture.deviceEnv);
  const firstDoctor = await cli(["doctor", "--project", fixture.proseRoot], { ...fixture.deviceEnv, HOME: fixture.home });
  const secondDoctor = await cli(["doctor", "--project", fixture.second.project], { ...fixture.deviceEnv, HOME: fixture.home });
  const { child, url, listening } = await startPortal(fixture);
  t.after(async () => { child.kill(); await rm(fixture.base, { recursive: true, force: true }); });
  assert.equal(listening.selectedBy, "argument");
  const { boot } = await readBoot(url);
  const listed = await request(url, "/api/libraries", readOptions(boot.token));
  assert.equal(listed.body.reasonCode, "PORTAL_LIBRARIES_READY");
  // The registry's name for a library is what project-list says of its project: its canonical name
  // (TCRN-CROSS-INIT-053 R46 I01; the fixture names each project by its external key).
  const firstName = (await cli(["project-list", "--workspace", fixture.workspace], fixture.deviceEnv)).records.find(record => record.id === fixture.projectId).name;
  const secondName = (await cli(["project-list", "--workspace", fixture.second.library], fixture.deviceEnv)).records.find(record => record.id === fixture.second.projectId).name;
  assert.deepEqual([firstName, secondName], ["TCRN-PORTAL-LIBRARIES", "TCRN-PORTAL-LIBRARIES-SECOND"]);
  assert.equal(boot.libraryName, firstName);
  assert.deepEqual(listed.body.libraries, [
    { projectPath: fixture.proseRoot, projectId: fixture.projectId, configurationProjectId: null, libraryId: first.workspaceId, libraryPath: fixture.workspace, name: firstName, chain: null },
    { projectPath: fixture.second.project, projectId: fixture.second.projectId, configurationProjectId: null, libraryId: second.workspaceId, libraryPath: fixture.second.library, name: secondName, chain: null },
  ]);
  assert.deepEqual(listed.body.selected, { ...listed.body.libraries[0], configurationProjectId: fixture.projectId });
  assert.deepEqual(boot.libraries, listed.body.libraries);

  const statusNow = async () => (await request(url, "/api/status", readOptions(boot.token))).body;
  const languageNow = async () => (await request(url, "/api/settings", readOptions(boot.token))).body.settings.find((entry) => entry.key === "artifact.language").currentValue;
  let status = await statusNow();
  assert.deepEqual([status.workspaceId, status.version], [first.workspaceId, first.version]);
  assert.equal(status.ok, firstDoctor.ok);
  assert.deepEqual(status.checks.map(({ check, ok, reasonCode }) => ({ check, ok, reasonCode })), firstDoctor.checks.map(({ check, ok, reasonCode }) => ({ check, ok, reasonCode })));
  assert.deepEqual(status.library.versionVector, first.versionVector);
  assert.equal(status.library.rejectedEventCount, first.rejectedEventCount);
  assert.deepEqual(status.library.configProjection, first.configProjection);
  assert.equal(await languageNow(), "en");

  const switched = await request(url, "/api/library", writeOptions(boot.token, "POST", { library: fixture.second.project }));
  assert.equal(switched.response.status, 200);
  assert.equal(switched.body.reasonCode, "PORTAL_LIBRARY_SELECTED");
  assert.deepEqual(switched.body.library, { ...listed.body.libraries[1], configurationProjectId: listed.body.libraries[1].projectId });
  assert.equal(switched.body.libraryName, secondName);
  assert.equal(switched.body.workspace, fixture.second.library);
  assert.equal(switched.body.proseRoot, fixture.second.project);
  status = await statusNow();
  assert.deepEqual([status.workspaceId, status.version], [second.workspaceId, second.version]);
  assert.equal(status.ok, secondDoctor.ok);
  assert.deepEqual(status.checks.map(({ check, ok, reasonCode }) => ({ check, ok, reasonCode })), secondDoctor.checks.map(({ check, ok, reasonCode }) => ({ check, ok, reasonCode })));
  assert.deepEqual(status.library.versionVector, second.versionVector);
  assert.equal(status.library.rejectedEventCount, second.rejectedEventCount);
  assert.deepEqual(status.library.configProjection, second.configProjection);
  assert.equal(await languageNow(), "zh-CN");
  assert.deepEqual((await request(url, "/api/libraries", readOptions(boot.token))).body.selected, { ...listed.body.libraries[1], configurationProjectId: fixture.second.projectId });

  // A library is named by its id too; the switch back reads the first library again.
  const back = await request(url, "/api/library", writeOptions(boot.token, "POST", { library: first.workspaceId }));
  assert.equal(back.body.reasonCode, "PORTAL_LIBRARY_SELECTED");
  status = await statusNow();
  assert.deepEqual([status.workspaceId, status.version], [first.workspaceId, first.version]);
  assert.equal(status.ok, firstDoctor.ok);
  assert.deepEqual(status.checks.map(({ check, ok, reasonCode }) => ({ check, ok, reasonCode })), firstDoctor.checks.map(({ check, ok, reasonCode }) => ({ check, ok, reasonCode })));
  assert.deepEqual(status.library.versionVector, first.versionVector);

  const unknown = await request(url, "/api/library", writeOptions(boot.token, "POST", { library: join(fixture.base, "not-a-library") }));
  assert.equal(unknown.response.status, 404);
  assert.equal(unknown.body.reasonCode, "PORTAL_LIBRARY_UNKNOWN");
  assert.equal((await statusNow()).workspaceId, first.workspaceId, "a refused switch leaves the selection alone");
  // The partition catalog and its switch are gone with the container.
  for (const path of ["/api/partitions", "/api/partition"]) {
    const retired = await request(url, path, readOptions(boot.token));
    assert.equal(retired.response.status, 404, path);
    assert.equal(retired.body.reasonCode, "PORTAL_ROUTE_UNKNOWN", path);
  }
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


// TCRN-CROSS-SUB-423 (STORY-513 R2; MIN-238 D3): the gate page's cover input, its cover column and the
// column's add and remove buttons say what a cover is, in all five languages: a path glob or a work id,
// the two forms `gates-config-set --covers` takes (docs/wiki/Gates.md). None says any more that a cover
// is a path, and the page's own text before a language applies is the English copy.
test("SUB-423 (STORY-513 R2, MIN-238 D3): the cover input, the cover column and its add and remove buttons say a path glob or a work id, in every language", async () => {
  const source = await readFile(join(portalRoot, "index.html"), "utf8");
  assert.match(source, /data-i18n="gates\.coversInput">[^<]*<\/span><textarea [^>]*name="covers"/u, "the cover input is labelled by gates.coversInput");
  assert.match(source, /data-ui="gate-config-table"[^>]*>[\s\S]*?role="columnheader" data-i18n="gates\.columnCovers"/u, "the cover column is headed by gates.columnCovers");
  assert.match(source, /data-gate-add-cover>\$\{esc\(t\("gates\.addCover"\)\)\}<\/button>/u, "the add button reads gates.addCover");
  assert.match(source, /data-gate-remove-cover aria-label="\$\{esc\(t\("gates\.removeCover"\)\)\}"/u, "the remove button is named by gates.removeCover");
  const sandbox = {};
  new Function("window", await readFile(join(portalRoot, "locales.js"), "utf8"))(sandbox);
  for (const key of ["gates.coversInput", "gates.columnCovers"]) {
    const fallback = source.match(new RegExp(`data-i18n="${key.replace(".", "\\.")}">([^<]*)<`, "u"))?.[1];
    assert.equal(fallback, sandbox.PORTAL_LOCALES.en[key], `${key}: the page's own text is the English copy`);
  }
  const terms = {
    en: { says: /path glob or (?:a )?work id/u, retired: /covered path|Remove path/iu },
    "zh-CN": { says: /路径 glob 或 work id/u, retired: /覆盖路径|移除路径/u },
    ja: { says: /パスの glob または work id/u, retired: /対象パス|パスを削除/u },
    ko: { says: /경로 glob 또는 work id/u, retired: /대상 경로|경로 제거/u },
    fr: { says: /glob de chemin ou (?:un )?work id/u, retired: /Chemins couverts|Ajouter un chemin|Retirer le chemin/u },
  };
  assert.deepEqual(Object.keys(sandbox.PORTAL_LOCALES).sort(), Object.keys(terms).sort());
  for (const [locale, { says, retired }] of Object.entries(terms)) {
    for (const key of ["gates.coversInput", "gates.columnCovers", "gates.addCover", "gates.removeCover"]) {
      const text = sandbox.PORTAL_LOCALES[locale][key];
      assert.match(text, says, `${locale} ${key}`);
      assert.doesNotMatch(text, retired, `${locale} ${key}`);
    }
  }
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


test("STORY-355 GWT1+GWT2: a forged Host header is refused on every route, and the token now guards every GET under /api/", async (t) => {
  const fixture = await scratch("tcrn-portal-security-", "TCRN-PORTAL-SECURITY");
  const { child, url } = await startPortal(fixture);
  t.after(async () => { child.kill(); await rm(fixture.base, { recursive: true, force: true }); });
  const { boot } = await readBoot(url);

  // GWT1: a DNS-rebinding-style Host header is rejected before any route runs at all,
  // including "/" -- the real TCP connection still lands on loopback (rawRequest talks
  // to the portal's actual address), only the Host header is forged.
  const rootForged = await rawRequest(url, "/", { host: "attacker.example" });
  assert.equal(rootForged.status, 403);
  assert.equal(rootForged.body.reasonCode, "PORTAL_HOST_REJECTED");
  const prefixForged = await rawRequest(url, "/api/settings", { host: "127.0.0.1.attacker.example" });
  assert.equal(prefixForged.status, 403);
  assert.equal(prefixForged.body.reasonCode, "PORTAL_HOST_REJECTED");
  const badPort = await rawRequest(url, "/api/settings", { host: "127.0.0.1:notaport" });
  assert.equal(badPort.status, 403);
  assert.equal(badPort.body.reasonCode, "PORTAL_HOST_REJECTED");
  const upperLocalhost = await rawRequest(url, "/api/settings", { host: "LOCALHOST", headers: { "x-portal-token": boot.token } });
  assert.equal(upperLocalhost.status, 200);

  // GWT2: token coverage now spans GET, not just the mutating verbs it used to guard alone.
  const untokenedGet = await request(url, "/api/settings");
  assert.equal(untokenedGet.response.status, 403);
  assert.equal(untokenedGet.body.reasonCode, "PORTAL_TOKEN_REQUIRED");
  const tokenedGet = await request(url, "/api/settings", readOptions(boot.token));
  assert.equal(tokenedGet.response.status, 200);
});


// TCRN-CROSS-STORY-482 R3: without --library the portal chooses from the registry by where it was
// started: the library of the registered project it runs in (library-resolve), else the machine's
// default library when that names a registered one, else the first registered library.
test("STORY-482 R3: without --library the portal opens the working directory's library, then the machine's default library, then the first registered one", async (t) => {
  const fixture = await scratch("tcrn-portal-default-library-", "TCRN-PORTAL-DEFAULT-LIBRARY");
  t.after(() => rm(fixture.base, { recursive: true, force: true }));
  const second = await cli(["status", "--workspace", fixture.second.library], fixture.deviceEnv);
  const open = async (cwd) => {
    const portal = await startPortal({ ...fixture, library: null, cwd });
    try {
      const { boot } = await readBoot(portal.url);
      return { selectedBy: portal.listening.selectedBy, libraryPath: boot.library.libraryPath, proseRoot: boot.proseRoot };
    } finally { portal.child.kill(); }
  };
  assert.deepEqual(await open(fixture.second.project), { selectedBy: "working-directory", libraryPath: fixture.second.library, proseRoot: fixture.second.project });
  await cli(["machine-settings-set", "--at", "2026-08-11T15:03:00Z", "--key", "portal.defaultPartition", "--value", second.workspaceId], fixture.deviceEnv);
  assert.deepEqual(await open(fixture.base), { selectedBy: "machine-default", libraryPath: fixture.second.library, proseRoot: fixture.second.project });
  // A default that names no registered library (an old partition id, say) is passed over.
  await cli(["machine-settings-set", "--at", "2026-08-11T15:04:00Z", "--key", "portal.defaultPartition", "--value", "cross-project"], fixture.deviceEnv);
  assert.deepEqual(await open(fixture.base), { selectedBy: "first-registered", libraryPath: fixture.workspace, proseRoot: fixture.proseRoot });
});


// STORY-355 carried over to libraries: AGENTS.md is the project's prose and never a file inside a
// library, which only the engine writes. A project registered inside its own library is refused
// at boot and on a switch, and the refusal names the path.
test("STORY-355: a project registered inside its own library is refused at boot and on a switch", async (t) => {
  const fixture = await scratch("tcrn-portal-prose-unsafe-", "TCRN-PORTAL-PROSE-UNSAFE");
  const nested = join(fixture.second.library, "nested-project");
  await mkdir(nested);
  await cli(["library-register", "--project", nested, "--library", fixture.second.library, "--project-id", fixture.second.projectId, "--at", "2026-08-11T15:05:00Z"], fixture.deviceEnv);
  const refused = await startupRefusal(["--library", nested], { ...fixture.deviceEnv, HOME: fixture.home });
  assert.equal(refused.status, 2);
  assert.equal(refused.report.ok, false);
  assert.equal(refused.report.reasonCode, "PORTAL_PROSE_ROOT_UNSAFE");
  assert.equal(refused.report.proseRoot, nested);
  const { child, url } = await startPortal(fixture);
  t.after(async () => { child.kill(); await rm(fixture.base, { recursive: true, force: true }); });
  const { boot } = await readBoot(url);
  const switched = await request(url, "/api/library", writeOptions(boot.token, "POST", { library: nested }));
  assert.equal(switched.response.status, 409);
  assert.equal(switched.body.reasonCode, "PORTAL_PROSE_ROOT_UNSAFE");
  assert.equal((await request(url, "/api/libraries", readOptions(boot.token))).body.selected.libraryPath, fixture.workspace, "a refused switch leaves the selection alone");
});


// TCRN-CROSS-STORY-482 R3: a library outside the registry is not something Atelier opens. With no
// registered library the portal refuses to start and names the remedy; a --library the device has
// not registered is named back, with the libraries it has.
test("STORY-482 R3: the portal refuses to start with no registered library, and names a --library the device has not registered", async (t) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-portal-no-library-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = await scratchHome(base);
  const deviceEnv = { EINZBERN_HOME: join(base, "device", "einzbern") };
  const empty = await startupRefusal([], { ...deviceEnv, HOME: home }, base);
  assert.equal(empty.status, 2);
  assert.equal(empty.report.reasonCode, "PORTAL_LIBRARY_REGISTRY_EMPTY");
  assert.equal(empty.report.remedy, "library-register");
  const project = join(base, "project");
  await registeredLibrary(deviceEnv, project, join(project, ".ether"), "TCRN-PORTAL-NO-LIBRARY", "2026-08-11T15:00:00Z");
  const loose = join(base, "unregistered-library");
  await cli(["init", "--workspace", loose, "--project-name", "TCRN-PORTAL-UNREGISTERED", "--at", "2026-08-11T15:00:01Z"], deviceEnv);
  const unknown = await startupRefusal(["--library", loose], { ...deviceEnv, HOME: home }, base);
  assert.equal(unknown.status, 2);
  assert.equal(unknown.report.reasonCode, "PORTAL_LIBRARY_UNKNOWN");
  assert.equal(unknown.report.requestedLibrary, loose);
  assert.deepEqual(unknown.report.libraries, [join(project, ".ether")]);
});


// TCRN-CROSS-STORY-528 (MIN-256; TCRN-CROSS-SUB-459), GWT5's Atelier part: the work read carries each
// item's lease, and Atelier's forced release frees another actor's running lease, written as
// TCRN_PORTAL_ACTOR; afterwards work-show shows no lease. The library signs its events, so the
// release's actor can be read off its event.
test("528 SUB-459: the work read carries each item's lease, and Atelier releases one by force as TCRN_PORTAL_ACTOR", async t => {
  const { appendHistoricalAttestationEnable } = await import("../../tests/helpers/workspace-fixture.mjs");
  const { readOwnStream } = await import("../../tests/helpers/library-forge.mjs");
  const fixture = await scratch("portal-work-lease-", "WORK-LEASE");
  const portalActor = "agent:test-portal";
  const holder = "agent:alpha";
  const previousHome = process.env.EINZBERN_HOME;
  process.env.EINZBERN_HOME = fixture.deviceEnv.EINZBERN_HOME;
  try {
    await appendHistoricalAttestationEnable(fixture.workspace, { occurredAt: "2026-08-11T15:00:02Z", actorId: holder });
  } finally {
    process.env.EINZBERN_HOME = previousHome;
  }
  let second = 2;
  const at = () => `2026-08-11T15:00:${String(second += 1).padStart(2, "0")}Z`;
  const create = async (externalKey, kind, extra) => (await cli(["work-create", "--workspace", fixture.workspace, "--project-id", fixture.projectId, "--at", at(), "--actor", holder, "--external-key", externalKey, "--kind", kind, ...extra], fixture.deviceEnv)).record;
  const initiative = await create("WORK-LEASE-INIT", "Initiative", ["--title", "Leased initiative"]);
  const epic = await create("WORK-LEASE-EPIC", "Epic", ["--parent-id", initiative.id, "--title", "Leased epic"]);
  const story = await create("WORK-LEASE-STORY", "Story", ["--parent-id", epic.id, "--title", "Leased story", "--goal", "One writer at a time.", "--acceptance", "Given a lease When another actor writes Then it is refused."]);
  // The read judges whether a lease runs by the clock, so the claim is taken at this moment.
  const claimedAt = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString().replace(".000Z", "Z");
  const expiresAt = new Date(Date.parse(claimedAt) + 2 * 3_600_000).toISOString().replace(".000Z", "Z");
  await cli(["work-claim", "--workspace", fixture.workspace, "--at", claimedAt, "--id", story.id, "--actor", holder], fixture.deviceEnv);

  const { child, url } = await startPortal({ ...fixture, env: { TCRN_PORTAL_ACTOR: portalActor } });
  t.after(async () => { if (child.exitCode === null) { const exited = new Promise(resolve => child.once("exit", resolve)); child.kill(); await exited; } await rm(fixture.base, { recursive: true, force: true }); });
  const { boot } = await readBoot(url);
  const work = await request(url, "/api/work", readOptions(boot.token));
  assert.equal(work.body.ok, true);
  const leases = Object.fromEntries(work.body.records.map((record) => [record.id, record.lease]));
  assert.deepEqual(leases, { [initiative.id]: null, [epic.id]: null, [story.id]: { holder, claimedAt, expiresAt, active: true } });

  const released = await request(url, "/api/work/lease-release", writeOptions(boot.token, "POST", { id: story.id }));
  assert.equal(released.body.ok, true, JSON.stringify(released.body));
  assert.equal(released.body.lease, null);
  assert.equal((await cli(["work-show", "--workspace", fixture.workspace, "--id", story.id], fixture.deviceEnv)).lease, null, "after the forced release work-show shows no lease");
  const last = (await readOwnStream(fixture.workspace)).events.at(-1);
  assert.deepEqual([last.payload.operation, last.payload.record.collection, last.payload.record.key, last.payload.actor], ["config.record.removed", "lease", story.id, portalActor], "the release's event names TCRN_PORTAL_ACTOR");
  const reread = await request(url, "/api/work", readOptions(boot.token));
  assert.equal(reread.body.records.find((record) => record.id === story.id).lease, null);

  const nothing = await request(url, "/api/work/lease-release", writeOptions(boot.token, "POST", { id: story.id }));
  assert.equal(nothing.body.ok, false);
  assert.equal(nothing.body.reasonCode, "WORK_LEASE_NOT_FOUND", "an item without a lease has nothing to release");
});
