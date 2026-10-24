// SPDX-License-Identifier: Apache-2.0
import { canonicalDocumentBytes } from "../../scripts/lib/canonical-json.mjs";
// Tests in this file run sequentially; Node isolates each file in a process.
import { LARGE_STORIES, appendHistoricalAttestationEnable, assert, cli, join, largeLibrary, pageOf, pagedWork, portalRoot, readBoot, readFile, readOptions, request, rm, scratch, startPortal, test, unordered, workPagesHarness, writeFile, writeOptions } from "./portal-support.mjs";



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



// R46 I04 (U20 D5): a new library's knowledge view is an empty inventory that says so; once a store
// exists the view says present.
test("INIT-053 R46 I04: /api/knowledge answers a library without a knowledge store as an empty inventory", async t => {
  const fixture = await scratch("portal-r46-knowledge-", "R46-KNOWLEDGE");
  const { child, url } = await startPortal(fixture);
  t.after(async () => { if (child.exitCode === null) { const exited = new Promise(resolve => child.once("exit", resolve)); child.kill(); await exited; } await rm(fixture.base, { recursive: true, force: true }); });
  const { boot } = await readBoot(url);
  const empty = await request(url, "/api/knowledge", readOptions(boot.token));
  assert.equal(empty.response.status, 200);
  assert.deepEqual([empty.body.ok, empty.body.reasonCode, empty.body.knowledgeStore, empty.body.records, empty.body.total], [true, "PORTAL_KNOWLEDGE_READY", "absent", [], 0]);
  await cli(["knowledge-init", "--workspace", fixture.workspace, "--acknowledge-disposable", "true"], fixture.deviceEnv);
  const present = await request(url, "/api/knowledge", readOptions(boot.token));
  assert.deepEqual([present.body.reasonCode, present.body.knowledgeStore, present.body.total], ["PORTAL_KNOWLEDGE_READY", "present", 0]);
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

// INIT068 SUB636: adapters return the engine's canonical draft/context, not UI-owned acceptance.
test("INIT068: typed drafts share CLI data, preserve empty completion, and reject a non-Story defect", async t => {
  const fixture = await scratch("portal-init068-draft-", "INIT068-DRAFT");
  const { child, url } = await startPortal(fixture);
  t.after(async () => { if (child.exitCode === null) { const exited = new Promise(resolve => child.once("exit", resolve)); child.kill(); await exited; } await rm(fixture.base, { recursive: true, force: true }); });
  const { boot } = await readBoot(url);
  for (const [kind, variant] of [["Initiative", "standard"], ["Epic", "standard"], ["Story", "standard"], ["Subtask", "standard"], ["Story", "defect"]]) {
    const expected = await cli(["work-draft", "--workspace", fixture.workspace, "--project-id", fixture.projectId, "--kind", kind, "--variant", variant], fixture.deviceEnv);
    const result = await request(url, `/api/work/draft?projectId=${fixture.projectId}&kind=${kind}&variant=${variant}`, readOptions(boot.token));
    assert.equal(result.body.ok, true);
    for (const field of ["content", "missing", "contentTemplate", "contentPolicy", "contentRolloutReadiness", "inheritedContext"]) assert.deepEqual(result.body[field], expected[field]);
    assert.equal(Object.hasOwn(result.body.content, "completion"), false);
    assert.ok(result.body.missing.includes("sources"));
    assert.ok(result.body.missing.includes("acceptance"));
  }
  const invalid = await request(url, `/api/work/draft?projectId=${fixture.projectId}&kind=Epic&variant=defect`, readOptions(boot.token));
  assert.equal(invalid.body.ok, false);
});

test("INIT068: long legacy context is segmented without loss; ancestry changes invalidate continuation", async t => {
  const fixture = await scratch("portal-init068-segment-", "INIT068-SEGMENT");
  const parent = (await cli(["work-create", "--workspace", fixture.workspace, "--project-id", fixture.projectId, "--at", "2026-08-11T15:01:00Z", "--external-key", "INIT068-SEGMENT-INIT", "--kind", "Initiative", "--title", "Legacy source", "--body", "Critical constraint 🧭\n".repeat(600)], fixture.deviceEnv)).record;
  const { child, url } = await startPortal(fixture);
  t.after(async () => { if (child.exitCode === null) { const exited = new Promise(resolve => child.once("exit", resolve)); child.kill(); await exited; } await rm(fixture.base, { recursive: true, force: true }); });
  const { boot } = await readBoot(url);
  const expected = await cli(["work-show", "--workspace", fixture.workspace, "--id", parent.id], fixture.deviceEnv);
  const childDraft = (await request(url, `/api/work/draft?projectId=${fixture.projectId}&kind=Epic&parentId=${parent.id}`, readOptions(boot.token))).body;
  assert.deepEqual(childDraft.inheritedContext, expected.workContent, "parent sources and constraints are read from the same context");
  let offset = 0, digest, text = "";
  do {
    const segment = (await request(url, `/api/work/content-context?id=${parent.id}&offset=${offset}&limit=1024${digest ? "&digest=" + digest : ""}`, readOptions(boot.token))).body;
    assert.equal(segment.ok, true);
    assert.equal(segment.offset, offset);
    assert.equal(segment.offsetUnit, "unicode-code-point");
    if (digest) assert.equal(segment.digest, digest);
    digest = segment.digest; text += segment.text; offset = segment.nextOffset;
  } while (offset !== null);
  assert.deepEqual(JSON.parse(text), expected.workContent);
  const shown = (await request(url, `/api/work/content?id=${parent.id}`, readOptions(boot.token))).body;
  assert.deepEqual(shown.content, expected.content);
  assert.deepEqual(shown.fields, expected.fields);
  await cli(["work-annotate", "--workspace", fixture.workspace, "--at", "2026-08-11T15:02:00Z", "--id", parent.id, "--expected-revision", String(parent.revision), "--body", "Changed source"], fixture.deviceEnv);
  const changed = (await request(url, `/api/work/content-context?id=${parent.id}&offset=1024&limit=1024&digest=${digest}`, readOptions(boot.token))).body;
  assert.equal(changed.ok, false);
  assert.equal(changed.reasonCode, "WORK_CONTENT_CONTEXT_CHANGED");
});

test("INIT068: native content saves with admitted binding, reads back canonically, and rejects stale revision without changing content", async t => {
  const fixture = await scratch("portal-init068-write-", "INIT068-WRITE");
  const draft = await cli(["work-draft", "--workspace", fixture.workspace, "--project-id", fixture.projectId, "--kind", "Initiative"], fixture.deviceEnv);
  const templatePath = join(fixture.base, "minimum-initiative.json");
  await writeFile(templatePath, canonicalDocumentBytes(draft.contentTemplate));
  const admitted = await cli(["template-admit", "--workspace", fixture.workspace, "--at", "2026-08-11T15:01:00Z", "--template", templatePath, "--owner", "owner:fixture"], fixture.deviceEnv);
  const { child, url } = await startPortal(fixture);
  t.after(async () => { if (child.exitCode === null) { const exited = new Promise(resolve => child.once("exit", resolve)); child.kill(); await exited; } await rm(fixture.base, { recursive: true, force: true }); });
  const { boot } = await readBoot(url);
  const create = { projectId: fixture.projectId, kind: "Initiative", externalKey: "INIT068-WRITE-INIT", title: "Canonical content", content: draft.content };
  const refused = (await request(url, "/api/work/content", writeOptions(boot.token, "POST", create))).body;
  assert.equal(refused.ok, false);
  assert.equal(refused.reasonCode, "WORK_CONTENT_TEMPLATE_REQUIRED", "a suggested template is not admission or opt-in");
  const saved = (await request(url, "/api/work/content", writeOptions(boot.token, "POST", { ...create, templateReceipt: admitted.receipt }))).body;
  assert.equal(saved.ok, true);
  const shown = (await request(url, `/api/work/content?id=${saved.record.id}`, readOptions(boot.token))).body;
  assert.deepEqual(shown.content, draft.content);
  assert.equal(shown.content.completion, undefined);
  assert.ok(shown.workContent.records[0].missing.includes("goal"), "planned drafts keep visible missing content");
  const content = { ...draft.content, body: "自由正文 — no imposed headings" };
  const updated = (await request(url, "/api/work/content", writeOptions(boot.token, "POST", { id: saved.record.id, revision: saved.record.revision, content }))).body;
  assert.equal(updated.ok, true);
  const stale = (await request(url, "/api/work/content", writeOptions(boot.token, "POST", { id: saved.record.id, revision: saved.record.revision, content: { ...content, body: "stale replacement" } }))).body;
  assert.equal(stale.ok, false);
  assert.deepEqual((await cli(["work-show", "--workspace", fixture.workspace, "--id", saved.record.id], fixture.deviceEnv)).content, content);
});
