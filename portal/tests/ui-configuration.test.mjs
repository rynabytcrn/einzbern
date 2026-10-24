// SPDX-License-Identifier: Apache-2.0
// Tests in this file run sequentially; Node isolates each file in a process.
import { COMPLETE_ID, DS_CONTRACT, GHOST_TARGET, MUTATION, appendHistoricalGateCreate, asFixtureDevice, assert, cli, closePage, coordinationContainerFixture, join, keydown, loadExecutedDom, localeTable, mkdir, nextAt, openWorkEditor, policySwitchControls, policySwitchViews, portalRoot, preparePage, projectChainFixture, readFile, receiptAdvanced, receiptText, rm, scratch, test, waitFor, writeFile } from "./ui-presence-support.mjs";

if (!MUTATION) {

  test("INC-183 every live enum setting is its own dictionary entry", async () => {
    const page = await preparePage();
    try {
      const navFor = (category) => page.document.querySelector(`[data-vocabulary-category="${category}"]`);
      assert.equal(navFor("settingsEnums"), null, "the retired shared settings-enum domain must not appear");
      assert.equal(page.document.querySelector('[data-vocabulary-table="settingsEnums"]'), null);
      const entries = [...page.document.querySelectorAll("[data-vocabulary-category]")]
        .map((button) => button.dataset.vocabularyCategory)
        .filter((category) => category.startsWith("setting:"));
      assert.deepEqual(entries, ["setting:agents.generation", "setting:agents.sharedNavigation", "setting:artifact.language"], "every live closed-enum setting belongs in the vocabulary");
      const entry = navFor("setting:artifact.language");
      assert.notEqual(entry.textContent.trim(), "artifact.language", "the entry is named, not keyed");
      entry.dispatchEvent(new page.window.Event("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 80));
      const shell = page.document.querySelector('[data-vocabulary-table="setting:artifact.language"]');
      assert.ok(shell, "the entry must render its own table");
      const rows = [...shell.querySelectorAll(".tcrn-table-shell__row")];
      const cell = (row, label) => [...row.children].find((node) => node.getAttribute("data-label") === label)?.textContent.trim() ?? "";
      const catalog = await cli(["settings-catalog", "--workspace", page.workspace], page.deviceEnv);
      const languageSetting = catalog.settings.find((setting) => setting.key === "artifact.language");
      assert.deepEqual(rows.map((row) => cell(row, "Value")), languageSetting.allowedValues);
      assert.ok(rows.every((row) => [...row.children].every((node) => node.textContent.trim().length > 0)), "no cell may be blank");
    } finally { await page.cleanup(); }
  });
}



test("PR24 U3: failed write after Undo recovers a replacement draft without another edit", async () => {
  const fixture = await scratch("tcrn-pr24-replaced-write-");
  const page = await loadExecutedDom(fixture);
  try {
    page.document.querySelector('[data-page-target="engine-model-policy"]').click();
    const { control, change } = policySwitchControls(page, "#engine-model-policy-view");
    change(control("decision"), "minutes:synthetic-sent#D1", "input");
    page.hold((path) => path === "/api/model-policy");
    control("save").click();
    await waitFor(() => page.held() === 1, "the pending write before Undo");
    control("undo").click();
    change(control("decision"), "minutes:synthetic-replacement#D1", "input");
    assert.equal(control("save").disabled, true);
    page.release({ error: new Error("PR24 isolated write failure") });
    await page.waitForSettled();
    const receipt = JSON.parse(page.document.querySelector("#receipt-raw").textContent);
    assert.equal(receipt.reasonCode, "PORTAL_RESPONSE_UNAVAILABLE");
    assert.equal(receipt.outcome, "unknown", "a lost response cannot establish that the write failed to commit");
    assert.equal(receipt.retrySafe, false);
    assert.equal(JSON.stringify(receipt).includes("PR24 isolated write failure"), false);
    assert.equal(control("decision").value, "minutes:synthetic-replacement#D1");
    assert.equal(control("save").disabled, false, "settled failed write releases the replacement draft without an extra edit");
  } finally { page.release(); await closePage(page, fixture); }
});

if (!MUTATION) {

  test("TCRN-CROSS-SUB-342 variables page creates, updates, renames, and deletes with an AGENTS.md readback", async (t) => {
    const page = await preparePage();
    // Failure-only, bounded observations for this exact lifecycle. Never retain
    // request bodies/headers, response payloads, raw DOM, paths outside this allowlist,
    // variable values or error messages. Observing json() does not read/clone it early.
    const started = Date.now();
    const elapsed = () => Date.now() - started;
    const trace = { requests: [], snapshots: [], droppedRequests: 0 };
    let phase = "create";
    let renamePost = null;
    let originalFailure = null;
    const semantic = (body) => ({
      reasonCode: typeof body?.reasonCode === "string" && /^[A-Z][A-Z0-9_]{0,95}$/u.test(body.reasonCode) ? body.reasonCode : null,
      version: Number.isSafeInteger(body?.version) ? body.version : null,
      ok: typeof body?.ok === "boolean" ? body.ok : null,
      persistence: body?.persistence === "committed" ? "committed" : null,
      outcome: ["unknown", "failed", "succeeded"].includes(body?.outcome) ? body.outcome : null,
      retrySafe: typeof body?.retrySafe === "boolean" ? body.retrySafe : null,
    });
    const snapshot = label => {
      const chip = receiptText(page.document);
      let receipt = null;
      try { receipt = JSON.parse(page.document.querySelector("#receipt-raw")?.textContent ?? "null"); } catch { /* only report the parse state, never raw text */ }
      const rowState = name => {
        const row = page.document.querySelector(`[data-variable-row="${name}"]`);
        const input = row?.querySelector('[data-variable-field="name"]');
        return { present: Boolean(row), saveDisabled: row?.querySelector("[data-variable-save]")?.disabled ?? null,
          nameIsHost: input?.value === "deploy.host", nameIsTarget: input?.value === "deploy.target" };
      };
      if (trace.snapshots.length === 8) trace.snapshots.shift();
      trace.snapshots.push({ label, phase, atMs: elapsed(), heldRequests: page.held(),
        receiptChip: /^(?:✓v[0-9]+|idle)$/u.test(chip) ? chip : "other",
        receiptParsed: receipt !== null, receipt: semantic(receipt), mutation: semantic(receipt?.mutation),
        renamePartial: receipt?.rename?.partialCommit === true,
        hostRow: rowState("deploy.host"), targetRow: rowState("deploy.target") });
    };
    const originalFetch = page.window.fetch;
    const observedPaths = new Set(["/api/variables", "/api/agents-md", "/api/agents-md/reconcile", "/api/rules"]);
    page.window.fetch = async (path, options = {}) => {
      if (!observedPaths.has(String(path))) return originalFetch(path, options);
      const entry = { path: String(path), method: ["GET", "POST", "DELETE"].includes(options.method ?? "GET") ? options.method ?? "GET" : "other", phase, startMs: elapsed() };
      if (trace.requests.length === 64) { trace.requests.shift(); trace.droppedRequests += 1; }
      trace.requests.push(entry);
      if (phase === "rename" && entry.path === "/api/variables" && entry.method === "POST") {
        // Bind the terminal observation to this phase's exact synthetic rename target.
        try { entry.requestIsRenameTarget = JSON.parse(options.body).name === "deploy.target"; }
        catch { entry.requestIsRenameTarget = false; }
        if (renamePost === null) renamePost = entry;
      }
      try {
        const response = await originalFetch(path, options);
        entry.endMs = elapsed(); entry.status = response.status;
        const originalJson = response.json.bind(response);
        response.json = async () => {
          entry.bodyStartMs = elapsed();
          try {
            const body = await originalJson();
            entry.bodyEndMs = elapsed(); entry.semantic = semantic(body);
            entry.mutation = semantic(body?.mutation); entry.render = semantic(body?.render);
            if (entry === renamePost) entry.renameReceipt = {
              variableWriteReceipt: body?.schemaVersion === "einzbern.variable-write-receipt.v1",
              recordIsTarget: body?.recordId === "deploy.target", variableIsTarget: body?.variable?.name === "deploy.target",
            };
            return body;
          } catch (error) { entry.bodyEndMs = elapsed(); entry.bodyFailed = true; throw error; }
        };
        return response;
      } catch (error) { entry.endMs = elapsed(); entry.fetchFailed = true; throw error; }
    };
    try {
      page.document.querySelector('[data-page-target="variables"]')?.click();
      const create = page.document.querySelector("[data-variable-create-row]");
      const field = (row, name) => row.querySelector(`[data-variable-field="${name}"]`);
      field(create, "name").value = "deploy.host";
      field(create, "type").value = "string";
      field(create, "value").value = "build.example.com";
      field(create, "description").value = "Build endpoint";
      create.querySelector('[data-variable-export="agents"]').checked = true;
      let before = receiptText(page.document);
      page.document.querySelector("[data-variable-create]").click();
      await waitFor(() => receiptAdvanced(page.document, before)(), "the variable create receipt");
      await waitFor(() => Boolean(page.document.querySelector('[data-variable-row="deploy.host"]')), "the variable create readback");
      assert.match(await readFile(join(page.fixture.proseRoot, "AGENTS.md"), "utf8"), /deploy\.host/u, "the successful write renders the variables section");

      phase = "update";
      let row = page.document.querySelector('[data-variable-row="deploy.host"]');
      field(row, "value").value = "stage.example.com";
      field(row, "description").value = "Staging endpoint";
      const editedRow = row;
      const updateReadback = () => {
        const current = page.document.querySelector('[data-variable-row="deploy.host"]');
        return Boolean(current && current !== editedRow && field(current, "value").value === "stage.example.com");
      };
      // The edited input already has the desired value before any server read.
      // Hold the real readback to prove that a draft cannot advance this case to
      // rename while the previous write's refresh is still pending.
      page.hold((path) => path === "/api/variables");
      before = receiptText(page.document);
      row.querySelector("[data-variable-save]").click();
      await waitFor(() => page.held() === 1, "the held variable update");
      assert.equal(page.release({ where: (_path, options) => options.method === "POST", keepHolding: true }), 1);
      await waitFor(() => receiptAdvanced(page.document, before)(), "the variable update receipt");
      await waitFor(() => page.held() === 1, "the held variable update readback");
      assert.equal(field(editedRow, "value").value, "stage.example.com", "the typed draft is not a readback signal");
      assert.equal(updateReadback(), false, "the case must wait for a freshly rendered server row");
      page.release();
      await waitFor(updateReadback, "the variable update readback");

      phase = "rename";
      snapshot("before-rename");
      row = page.document.querySelector('[data-variable-row="deploy.host"]');
      field(row, "name").value = "deploy.target";
      before = receiptText(page.document);
      row.querySelector("[data-variable-save]").click();
      snapshot("after-rename-click");
      // Two bounded observations, not a latency SLA or a retry: POST body terminal
      // <=15s, then the existing final receipt <=15s. Combined rename observation
      // may now take ~30s rather than the old combined 15s; this is not faster product
      // behavior. No progress resets either deadline; a refusal is terminal, not polled.
      await waitFor(() => renamePost && (renamePost.bodyEndMs !== undefined || renamePost.fetchFailed === true), "the rename POST terminal body", 15_000);
      assert.equal(renamePost.phase, "rename");
      assert.equal(renamePost.requestIsRenameTarget, true);
      assert.equal(trace.requests.filter(entry => entry.phase === "rename" && entry.path === "/api/variables" && entry.method === "POST").length, 1, "one rename POST, no retry");
      assert.equal(renamePost.fetchFailed, undefined);
      assert.equal(renamePost.bodyFailed, undefined);
      assert.equal(renamePost.status, 200);
      assert.deepEqual(renamePost.renameReceipt, { variableWriteReceipt: true, recordIsTarget: true, variableIsTarget: true });
      assert.equal(renamePost.semantic.ok, true);
      assert.equal(renamePost.semantic.reasonCode, "VARIABLE_WRITE_COMMITTED");
      assert.equal(renamePost.semantic.persistence, "committed");
      assert.ok(Number.isSafeInteger(renamePost.semantic.version) && renamePost.semantic.version >= 0);
      await waitFor(() => receiptAdvanced(page.document, before)(), "the variable rename receipt");
      snapshot("after-rename-receipt");
      await waitFor(() => Boolean(page.document.querySelector('[data-variable-row="deploy.target"]')), "the variable rename readback");
      assert.equal(page.document.querySelector('[data-variable-row="deploy.host"]'), null);
      assert.match(await readFile(join(page.fixture.proseRoot, "AGENTS.md"), "utf8"), /deploy\.target/u);

      phase = "delete";
      before = receiptText(page.document);
      page.document.querySelector('[data-variable-row="deploy.target"] [data-variable-delete]').click();
      await waitFor(() => receiptAdvanced(page.document, before)(), "the variable delete receipt");
      await waitFor(() => page.document.querySelector('[data-variable-row="deploy.target"]') === null, "the variable delete readback");
      const listed = await cli(["variable-list", "--workspace", page.workspace], page.deviceEnv);
      assert.deepEqual(listed.variables, []);
      assert.doesNotMatch(await readFile(join(page.fixture.proseRoot, "AGENTS.md"), "utf8"), /deploy\.target/u, "deleting a variable removes its managed row");
    } catch (error) {
      originalFailure = error;
      try { snapshot("failure-before-cleanup"); t.diagnostic("SUB342_VARIABLE_LIFECYCLE " + JSON.stringify(trace)); }
      catch { t.diagnostic("SUB342_VARIABLE_LIFECYCLE observation unavailable; original assertion retained"); }
      throw error;
    } finally {
      // Keep observation attached through the existing bounded settlement/cleanup,
      // without adding another wait or inferring state from a removed fixture.
      let cleanupFailure = null;
      try { page.release(); await page.cleanup(); }
      catch (error) { cleanupFailure = error; }
      finally {
        page.window.fetch = originalFetch;
        if (originalFailure !== null || cleanupFailure !== null) {
          trace.cleanup = { atMs: elapsed(), completed: cleanupFailure === null,
            childExitCode: page.child.exitCode, childSignal: page.child.signalCode,
            fixtureState: "not-inspected-after-cleanup" };
          try { t.diagnostic("SUB342_VARIABLE_LIFECYCLE_AFTER_CLEANUP " + JSON.stringify(trace)); }
          catch { t.diagnostic("SUB342_VARIABLE_LIFECYCLE post-cleanup observation unavailable"); }
        }
      }
      if (cleanupFailure !== null) {
        if (originalFailure === null) throw cleanupFailure;
        t.diagnostic("SUB342_VARIABLE_LIFECYCLE cleanup also failed; original assertion retained");
      }
    }
  });
}



if (!MUTATION) test("R45 U14: the page's label rule tells alike names apart by the shortest id tails and never shows a complete id", async () => {
  const source = await readFile(join(portalRoot, "index.html"), "utf8");
  const block = source.match(/\n {2}\/\/ Target labels \(TCRN-CROSS-INIT-053 R45 U14, F08\) begin\.\n([\s\S]*?)\n {2}\/\/ Target labels end\./u)?.[1];
  assert.ok(block, "the page states its label rule in one block");
  const locales = await localeTable();
  const rule = (locale) => new Function("t", `${block}\nreturn { distinctLabels, projectIdentity };`)((key) => locales[locale][key]);
  const { distinctLabels, projectIdentity } = rule("en");
  const id = (kind, hex) => `${kind}:${hex}`;
  const equalNames = [
    { name: "Payments", libraryId: id("library", `${"a".repeat(18)}000001`), projectId: id("project", `${"b".repeat(18)}000001`) },
    { name: "Payments", libraryId: id("library", `${"a".repeat(18)}000002`), projectId: id("project", `${"b".repeat(18)}000001`) },
  ];
  assert.deepEqual(distinctLabels(equalNames), ["Payments · 000001/000001", "Payments · 000002/000001"], "equal names carry six-character tails");
  const longPrefixNames = [
    { name: "Payments platform service for the EU region, primary", libraryId: id("library", "1".repeat(24)), projectId: id("project", "2".repeat(24)) },
    { name: "Payments platform service for the EU region, secondary", libraryId: id("library", "3".repeat(24)), projectId: id("project", "4".repeat(24)) },
  ];
  assert.deepEqual(distinctLabels(longPrefixNames), longPrefixNames.map((entry) => entry.name), "distinct names, however long their common prefix, need no tail");
  const longEqualTails = [
    { name: null, libraryId: id("library", `0${"c".repeat(23)}`), projectId: id("project", "d".repeat(24)) },
    { name: null, libraryId: id("library", `1${"c".repeat(23)}`), projectId: id("project", "d".repeat(24)) },
  ];
  const tailed = distinctLabels(longEqualTails);
  assert.equal(new Set(tailed).size, 2, "ids alike in their last 23 characters are still told apart");
  assert.deepEqual(tailed, [`Unnamed project · 0${"c".repeat(23)}/${"d".repeat(24)}`, `Unnamed project · 1${"c".repeat(23)}/${"d".repeat(24)}`]);
  for (const [entries, labels] of [[equalNames, distinctLabels(equalNames)], [longPrefixNames, distinctLabels(longPrefixNames)], [longEqualTails, tailed]]) {
    for (const label of labels) assert.doesNotMatch(label, COMPLETE_ID, "a label never holds a complete library: or project: id");
    assert.deepEqual(entries.map(projectIdentity), entries.map((entry) => `${entry.libraryId} / ${entry.projectId}`), "the complete identity is kept for the Details");
  }
  assert.deepEqual(distinctLabels([{ ...GHOST_TARGET, availability: "unavailable" }, { name: null, ...GHOST_TARGET }]), ["Unavailable project", "Unnamed project"], "an unavailable reference and an unnamed project have different words");
  const seen = new Set();
  for (const locale of Object.keys(locales)) {
    const { distinctLabels: localized } = rule(locale);
    const [label] = localized([{ name: "", libraryId: GHOST_TARGET.libraryId, projectId: GHOST_TARGET.projectId }]);
    assert.equal(label, locales[locale]["projects.unnamed"], `${locale}: an unnamed project reads in the page's language`);
    assert.notEqual(label, locales[locale]["projects.statusUnconfigured"], `${locale}: unnamed is not the word for an unconfigured state`);
    assert.equal(Object.hasOwn(locales[locale], "projects.unconfigured"), false, `${locale}: the colliding fallback key is gone`);
    seen.add(label);
  }
  assert.equal(seen.size, 5, "each language has its own word for an unnamed project");
});



// TCRN-CROSS-INIT-053 R46 (I11; U20 D2): one chain's project registered for two repositories is two
// registrations with one identity. The label rule tells them apart by their repositories' directory names,
// never by a path, and keeps the id tails for alike names that are different projects.
if (!MUTATION) test("R46 I11: the label rule tells one chain's two repositories apart by their directory names, never by a path", async () => {
  const source = await readFile(join(portalRoot, "index.html"), "utf8");
  const block = source.match(/\n {2}\/\/ Target labels \(TCRN-CROSS-INIT-053 R45 U14, F08\) begin\.\n([\s\S]*?)\n {2}\/\/ Target labels end\./u)?.[1];
  const locales = await localeTable();
  const { distinctLabels } = new Function("t", `${block}\nreturn { distinctLabels };`)((key) => locales.en[key]);
  const library = `library:${"a".repeat(24)}`;
  const project = `project:${"b".repeat(24)}`;
  const registrations = [
    { name: "Alpha", libraryId: library, projectId: project, projectPath: "/srv/work/alpha-einzbern" },
    { name: "Alpha", libraryId: library, projectId: project, projectPath: "/srv/work/alpha-mana" },
  ];
  assert.deepEqual(distinctLabels(registrations), ["Alpha · alpha-einzbern", "Alpha · alpha-mana"]);
  const sameLeaf = [
    { name: "Alpha", libraryId: library, projectId: project, projectPath: "srv\\work\\one\\app" },
    { name: "Alpha", libraryId: library, projectId: project, projectPath: "srv\\work\\two\\app" },
  ];
  assert.deepEqual(distinctLabels(sameLeaf), ["Alpha · one · app", "Alpha · two · app"], "directories that end alike are told apart by the one before");
  const other = { name: "Alpha", libraryId: `library:${"c".repeat(24)}`, projectId: `project:${"d".repeat(24)}`, projectPath: "/srv/work/alpha-other" };
  const mixed = distinctLabels([...registrations, other]);
  assert.deepEqual(mixed, ["Alpha · aaaaaa/bbbbbb · alpha-einzbern", "Alpha · aaaaaa/bbbbbb · alpha-mana", "Alpha · cccccc/dddddd"], "another project of the same name keeps its id tail");
  for (const label of [...distinctLabels(registrations), ...distinctLabels(sameLeaf)]) assert.doesNotMatch(label, /[\\/]/u, "no path separator in a repository's label");
  for (const label of [...distinctLabels(registrations), ...distinctLabels(sameLeaf), ...mixed]) {
    assert.doesNotMatch(label, /srv|work|C:/u, "no path above the directory that tells them apart");
    assert.doesNotMatch(label, COMPLETE_ID);
  }
  assert.deepEqual(distinctLabels([registrations[0]]), ["Alpha"], "a single registration is its name");
});



// TCRN-CROSS-INIT-053 R46 (I11; U20 D2, I06): in the page, the switcher names one chain's two repositories
// apart, and the Rules page names the repository whose AGENTS.md it edits; the full path is in the Details.
if (!MUTATION) test("R46 I11: the switcher tells one chain's two repositories apart, and the Rules page names the repository it edits", async () => {
  const fixture = await scratch("tcrn-r46-i11-");
  // The registry orders registrations by project path; "repo-mana" follows the fixture's own "project", so
  // the portal opens on the fixture's first registration.
  const mana = join(fixture.base, "repo-mana");
  await mkdir(mana);
  await cli(["library-register", "--project", mana, "--library", fixture.workspace, "--project-id", fixture.projectId, "--at", nextAt()], fixture.deviceEnv);
  await writeFile(join(mana, "AGENTS.md"), "# mana rules\n", "utf8");
  const locales = await localeTable();
  const page = await loadExecutedDom(fixture);
  try {
    const { document, window } = page;
    const options = [...document.querySelectorAll("#library-select option")];
    const byPath = Object.fromEntries(options.map((option) => [option.getAttribute("value"), option.textContent]));
    assert.equal(byPath[fixture.proseRoot], "TCRN-INC148-DOM · project");
    assert.equal(byPath[mana], "TCRN-INC148-DOM · repo-mana");
    assert.equal(byPath[fixture.second.project], "TCRN-INC148-DOM-SECOND");
    for (const option of options) {
      assert.doesNotMatch(option.textContent, /[\\/]/u, "no path in the switcher");
      assert.doesNotMatch(option.textContent, COMPLETE_ID);
    }
    assert.equal(document.querySelector("#rail-workspace-label").textContent, "TCRN-INC148-DOM · project");
    document.querySelector('[data-page-target="prose"]')?.click();
    assert.equal(document.querySelector("#agents-file").textContent, "AGENTS.md · project");
    const select = document.querySelector("#library-select");
    select.value = mana;
    select.dispatchEvent(new window.Event("change", { bubbles: true }));
    await waitFor(() => document.querySelector("#agents-file").textContent === "AGENTS.md · repo-mana", "the second repository's file");
    assert.equal(document.querySelector("#agents-md").value, "# mana rules\n", "the editor holds the second repository's file");
    const details = document.querySelector("#agents-path-details");
    assert.equal(details.tagName, "DETAILS");
    assert.equal(details.hidden, false);
    assert.ok(details.classList.contains("tcrn-disclosure-panel"));
    assert.equal(details.querySelector(":scope > summary").className, "tcrn-disclosure-panel__title");
    assert.equal(details.querySelector(":scope > summary").textContent, locales.en["prose.fullPath"]);
    assert.equal(document.querySelector("#agents-path").textContent, join(mana, "AGENTS.md"), "the full path is in the Details");
    const copy = details.querySelector("[data-copy-identity]");
    assert.equal(copy.getAttribute("data-copy-identity"), join(mana, "AGENTS.md"));
    assert.equal(copy.getAttribute("aria-label"), locales.en["prose.copyPath"].replace("{file}", "AGENTS.md"));
    details.setAttribute("open", "");
    let focused = 0;
    details.querySelector("summary").focus = () => { focused += 1; };
    keydown(page, copy, "Escape");
    assert.equal(details.hasAttribute("open"), false, "Escape closes the Details");
    assert.equal(focused, 1, "and returns focus to the summary");
    document.querySelector('[data-locale-option="ja"]')?.click();
    assert.equal(details.querySelector(":scope > summary").textContent, locales.ja["prose.fullPath"]);
    assert.equal(copy.getAttribute("aria-label"), locales.ja["prose.copyPath"].replace("{file}", "AGENTS.md"));
    assert.equal(document.querySelector("#agents-file").textContent, "AGENTS.md · repo-mana");
  } finally { await closePage(page, fixture); }
});



// TCRN-CROSS-INIT-053 R46 (I12; U20 D9, c1): a coordination chain has no legacy project
// model rows, while the device-level engine-host policy stays available independently of that scope.
if (!MUTATION) test("R46 I12: coordination settings omit project model rows while the engine-host views and gates remain available", async () => {
  const fixture = await projectChainFixture("tcrn-r46-i12-coordination-");
  const page = await loadExecutedDom(fixture);
  try {
    const { document, window } = page;
    const select = document.querySelector("#library-select");
    select.value = fixture.coordination.project;
    select.dispatchEvent(new window.Event("change", { bubbles: true }));
    await waitFor(() => document.querySelector("#rail-workspace-label").textContent === "TCRN-R45-COORDINATION", "the coordination chain");
    await page.waitForSettled();
    document.querySelector('[data-page-target="settings"]')?.click();
    assert.equal(document.querySelector('[data-setting-group="models"]'), null, "coordination settings expose no project model collection");
    document.querySelector('[data-page-target="engine-model-policy"]')?.click();
    assert.ok(document.querySelector('[data-engine-model-policy-host]'), "the device engine policy remains readable without a project-model scope");
    document.querySelector('[data-page-target="model-categories"]')?.click();
    assert.ok(document.querySelector('[data-collection-table="engine-model-policy-categories"]'), "the category projection still uses the engine source");
    document.querySelector('[data-page-target="gates"]')?.click();
    assert.ok(document.querySelector('#gate-add-form button[type="submit"][data-cli-action="gates-config-set"]'), "the gate page still adds a gate");
    document.querySelector('[data-locale-option="fr"]')?.click();
    document.querySelector('[data-page-target="model-tiers"]')?.click();
    assert.ok(document.querySelector('[data-collection-table="engine-model-policy-tiers"]')?.getAttribute("aria-label"), "the localized tier engine-policy table remains named");
  } finally { await closePage(page, fixture); }
});


// with no project; a fixture write of another of them names no project either. Its model pages stay as R46 I12.
if (!MUTATION) test("R47 c1-B: the coordination chain's artifact language saves from its settings page, for the whole library", async () => {
  const fixture = await projectChainFixture("tcrn-r47-c1b-coordination-");
  await cli(["settings-set", "--workspace", fixture.coordination.library, "--at", nextAt(), "--actor", "agent:test", "--key", "execution.maxConcurrentSubagents", "--value", "3"], fixture.atelier);
  const page = await loadExecutedDom(fixture);
  try {
    const { document, window } = page;
    const select = document.querySelector("#library-select");
    select.value = fixture.coordination.project;
    select.dispatchEvent(new window.Event("change", { bubbles: true }));
    await waitFor(() => document.querySelector("#rail-workspace-label").textContent === "TCRN-R45-COORDINATION", "the coordination chain");
    await page.waitForSettled();
    document.querySelector('[data-page-target="settings"]')?.click();
    document.querySelector('[data-setting-group="knowledge"]')?.click();
    const control = await waitFor(() => document.querySelector('[data-setting-row="artifact.language"] [data-setting-control]'), "the artifact language row");
    assert.equal(control.disabled, false, "the coordination chain's own setting can be changed");
    const before = receiptText(document);
    control.value = "fr";
    control.dispatchEvent(new window.Event("change", { bubbles: true }));
    await waitFor(receiptAdvanced(document, before), "the saved write's receipt");
    await page.waitForSettled();
    const catalog = await cli(["settings-catalog", "--workspace", fixture.coordination.library, "--project-id", fixture.coordination.projectId], fixture.deviceEnv);
    const row = (key) => catalog.settings.find((entry) => entry.key === key);
    assert.deepEqual([row("artifact.language").currentValue, row("artifact.language").declaredValue, row("artifact.language").scope, row("artifact.language").source.kind], ["fr", "fr", "library", "library"]);
    assert.deepEqual([row("execution.maxConcurrentSubagents").currentValue, row("execution.maxConcurrentSubagents").source.kind], ["3", "library"]);
    assert.equal(row("models.tiers"), undefined, "the model tables are not the coordination chain's");
  } finally { await closePage(page, fixture); }
});



// The Rules page of a selected coordination library names the container's AGENTS.md its rules and variables
// are written into and shows that file; a project library's Rules page carries no such note.
if (!MUTATION) test("540 SUB-508: a coordination library's Rules page names and shows the container's AGENTS.md, and a project's carries no such note", async (context) => {
  const fixture = await coordinationContainerFixture("tcrn-540-coordination-");
  const locales = await localeTable();
  const page = await loadExecutedDom({ ...fixture, workspace: fixture.coordination });
  try {
    const { document } = page;
    document.querySelector('[data-page-target="settings"]').click();
    document.querySelector('[data-setting-group="general"]').click();
    assert.equal(document.querySelector('[data-configuration-contract="agents.generation"]').dataset.effectiveScope, "library", "coordination metadata reports actual library scope");
    document.querySelector('[data-page-target="prose"]')?.click();
    const note = await waitFor(() => { const node = document.querySelector('[data-ui="prose-binding-note"]'); return node !== null && !node.hidden ? node : null; }, "the coordination note on the Rules page");
    assert.equal(note.dataset.bindingStatus, "bound");
    assert.equal(note.textContent, locales.en["prose.coordinationBound"].replace("{path}", fixture.container));
    assert.equal(document.querySelector("#agents-md").value, "# The container\n", "the editor shows the container's file");
    assert.equal(document.querySelector("#agents-path").textContent, join(fixture.container, "AGENTS.md"));
    assert.ok(document.querySelector('#prose-directory [data-rule-card="autonomy"] [data-rule-switch]'), "the rules can be switched on from the page");
    document.querySelector('[data-page-target="variables"]')?.click();
    assert.ok(document.querySelector('[data-ui="variables-view"]'), "the variables page is there for the coordination library");

    const select = document.querySelector("#library-select");
    select.value = fixture.proseRoot;
    select.dispatchEvent(new page.window.Event("change", { bubbles: true }));
    // A switch includes its dependent reads. Observe their existing settle signal,
    // then judge the content rather than turning a wrong path into a timeout.
    await page.waitForSettled();
    assert.equal(document.querySelector("#agents-path")?.textContent, join(fixture.proseRoot, "AGENTS.md"), "the settled page shows the project library's AGENTS.md");
    assert.equal(document.querySelector('[data-ui="prose-binding-note"]').hidden, true, "a project library's Rules page carries no coordination note");
  } catch (error) {
    // Keep a bounded pre-cleanup snapshot without replacing the original failure.
    try {
      context.diagnostic(JSON.stringify({
        schemaVersion: "tcrn.sub508-switch-diagnostic.v1",
        requestCount: page.requests.length,
        recentRequests: page.requests.slice(-24).map(path => path.slice(0, 256)),
        selectedLibrary: page.document.querySelector("#library-select")?.value,
        selectorDisabled: page.document.querySelector("#library-select")?.disabled,
        agentsPath: page.document.querySelector("#agents-path")?.textContent,
        noteHidden: page.document.querySelector('[data-ui="prose-binding-note"]')?.hidden,
        receipt: page.document.querySelector("#receipt-raw")?.textContent.slice(0, 1024),
      }));
    } catch { /* Diagnostic failure must not obscure the assertion or settle failure. */ }
    throw error;
  } finally { await closePage(page, fixture); }
});



// INIT-056 R5: this exercises the actual browser state rather than matching policy tokens in HTML. It
// covers an initially empty engine host, every policy field, governed failure and success receipts,
// five locale renderings, refresh preservation, write de-duplication, post-send edits, and Undo.
test("INIT-056 R5: the engine-host editor creates a complete policy and retains real drafts across receipts, locale, and refresh", async () => {
  const fixture = await scratch("tcrn-init056-r5-policy-ui-");
  const meeting = await cli([
    "minutes-record", "--workspace", fixture.workspace, "--at", nextAt(), "--project-id", fixture.projectId,
    "--external-key", "INIT056-R5-POLICY", "--title", "Engine policy editor",
    "--summary", "Owner authorizes the test engine model policy write.", "--decisions", "Set models.engine-policy for the Codex host.",
    "--decided-by", "owner:governance", "--actor", "agent:test",
  ], fixture.deviceEnv);
  const decision = `${meeting.id}#D1`;
  const page = await loadExecutedDom(fixture);
  try {
    const { document, window } = page;
    const view = () => document.querySelector("#engine-model-policy-view");
    const field = (kind, index, name) => view().querySelector(`[data-engine-policy-kind="${kind}"][data-engine-policy-index="${index}"][data-engine-policy-field="${name}"]`);
    const escalation = (name) => view().querySelector(`[data-engine-policy-escalation="${name}"]`);
    const type = (node, value, event = "input") => {
      assert.ok(node, `the ${node?.dataset.enginePolicyField ?? node?.dataset.enginePolicyEscalation ?? "policy"} control exists`);
      node.value = value;
      node.dispatchEvent(new window.Event(event, { bubbles: true }));
    };
    const save = () => view().querySelector("[data-engine-model-policy-save]");

    document.querySelector('[data-page-target="engine-model-policy"]').click();
    assert.ok(view().querySelector('[data-engine-model-policy-status="unconfigured"]'), "an unconfigured host gives a first-policy state");
    view().querySelector('[data-engine-policy-add="categories"]').click();
    await waitFor(() => document.activeElement === field("categories", 0, "id"), "the first category id to receive focus");
    type(field("categories", 0, "order"), "10");
    type(field("categories", 0, "id"), "main");
    type(field("categories", 0, "name"), "Main");
    type(field("categories", 0, "description"), "Everyday governed work");
    view().querySelector('[data-engine-policy-add="tiers"]').click();
    await waitFor(() => field("tiers", 0, "model"), "the first tier row");
    type(field("tiers", 0, "order"), "20");
    type(field("tiers", 0, "category"), "main", "change");
    type(field("tiers", 0, "runner"), "codex");
    type(field("tiers", 0, "model"), "gpt-5.6-terra");
    type(field("tiers", 0, "effort"), "max");
    type(field("tiers", 0, "note"), "R5 economy implementation");
    const enabled = escalation("enabled");
    enabled.checked = true;
    enabled.dispatchEvent(new window.Event("change", { bubbles: true }));
    type(escalation("threshold"), "2");
    type(escalation("ceiling"), "main", "change");

    const invalid = `minutes:${"f".repeat(24)}#D1`;
    type(view().querySelector("[data-engine-model-policy-decision]"), invalid);
    save().click();
    await page.waitForSettled();
    await waitFor(() => view().querySelector("[data-engine-model-policy-write-error]"), "the rejected governed write receipt");
    assert.equal(field("categories", 0, "description").value, "Everyday governed work", "a refusal keeps every category field");
    assert.equal(field("tiers", 0, "note").value, "R5 economy implementation", "a refusal keeps every tier field");
    assert.equal(view().querySelector("[data-engine-model-policy-decision]").value, invalid, "a refusal keeps its decision citation");

    type(view().querySelector("[data-engine-model-policy-decision]"), decision);
    save().click();
    await waitFor(() => document.querySelector("#receipt-raw")?.textContent.includes("ENGINE_MODEL_POLICY_WRITE_COMMITTED"), "the first governed engine-policy receipt");
    await page.waitForSettled();
    const stored = await cli(["engine-model-policy-catalog", "--host", "codex"], fixture.deviceEnv);
    assert.deepEqual(stored.selectedPolicy.categories, [{ order: 10, id: "main", name: "Main", description: "Everyday governed work" }]);
    assert.deepEqual(stored.selectedPolicy.tiers, [{ order: 20, category: "main", runner: "codex", model: "gpt-5.6-terra", effort: "max", note: "R5 economy implementation" }]);
    assert.deepEqual(stored.selectedPolicy.escalation, { enabled: true, threshold: 2, ceiling: "main" });

    document.querySelector('[data-page-target="settings"]').click();
    document.querySelector('[data-setting-group="models"]').click();
    for (const key of ["models.category", "models.tiers", "models.escalation.enabled", "models.escalation.threshold", "models.escalation.ceiling"]) {
      const row = document.querySelector(`[data-setting-row="${key}"]`);
      assert.ok(row?.matches("[data-model-policy-legacy=\"true\"]"), `${key} is visibly a compatibility record`);
      assert.equal(row.querySelector("[data-setting-control]"), null, `${key} exposes no project-setting write control`);
      assert.ok(row.querySelector('[data-model-policy-link="engine-model-policy"]'), `${key} links to the engine-host editor`);
    }
    document.querySelector('[data-model-policy-link="engine-model-policy"]').click();
    await waitFor(() => document.querySelector('[data-page="engine-model-policy"]')?.hidden === false, "the compatibility link to open the engine policy");

    // A locale redraw also reads project targets. Let each independent locale
    // interaction finish before the settings write below: waiting only for lang
    // can leave target reads queued beside that write and its full refresh.
    // Keep the existing request timeout and all draft/concurrency assertions.
    const selectLocale = async (locale) => {
      document.querySelector(`[data-locale-option="${locale}"]`).click();
      await waitFor(() => document.documentElement.lang === locale, `${locale} policy labels`);
      await page.waitForSettled();
    };
    for (const locale of ["en", "zh-CN", "ja", "ko", "fr"]) {
      await selectLocale(locale);
      assert.ok(view().querySelector("[data-engine-model-policy-host]")?.getAttribute("aria-label"), `${locale} host selector has an accessible name`);
      assert.ok(field("categories", 0, "id")?.getAttribute("aria-label"), `${locale} category id has an accessible name`);
      assert.ok(field("tiers", 0, "model")?.getAttribute("aria-label"), `${locale} model has an accessible name`);
      assert.equal(escalation("enabled")?.getAttribute("role"), "switch", `${locale} escalation uses the existing switch semantics`);
      assert.ok(view().textContent.trim() && !view().textContent.includes("modelPolicy."), `${locale} translates the engine policy surface`);
    }
    await selectLocale("en");
    type(field("tiers", 0, "note"), "kept through locale and refresh");
    await selectLocale("fr");
    await waitFor(() => field("tiers", 0, "note")?.value === "kept through locale and refresh", "the draft through a locale redraw");
    document.querySelector('[data-page-target="settings"]').click();
    document.querySelector('[data-setting-group="execution"]').click();
    const concurrency = document.querySelector('[data-setting-control="execution.maxConcurrentSubagents"]');
    type(concurrency, "3", "change");
    await page.waitForSettled();
    document.querySelector('[data-page-target="engine-model-policy"]').click();
    await waitFor(() => field("tiers", 0, "note")?.value === "kept through locale and refresh", "the draft through a shared refresh");

    type(field("tiers", 0, "note"), "sent draft");
    page.hold((path) => path === "/api/model-policy");
    const postBefore = page.requests.filter((path) => path === "/api/model-policy").length;
    save().click();
    await waitFor(() => page.held() === 1, "the first engine-policy write to be held");
    assert.equal(save().disabled, true, "Save is write-pending while the actual request is outstanding");
    save().click();
    assert.equal(page.requests.filter((path) => path === "/api/model-policy").length, postBefore + 1, "a pending Save never submits a duplicate write");
    type(field("tiers", 0, "model"), "gpt-6.1-sol");
    view().querySelector("[data-engine-model-policy-undo]").click();
    type(field("tiers", 0, "note"), "after Undo while write pending");
    assert.equal(page.release(), 1);
    await page.waitForSettled();
    await waitFor(() => field("tiers", 0, "note")?.value === "after Undo while write pending", "the post-send Undo draft after the old success returns");
    assert.equal(save().disabled, false, "the newer draft remains available for a later governed write");
  } finally { await closePage(page, fixture); }
});



if (!MUTATION) test("INIT-056 ordinary editor roundtrip keeps quota, all policy fields and five-locale controls", async () => {
  const fixture = await scratch("tcrn-init056-policy-roundtrip-");
  const meeting = await cli(["minutes-record", "--workspace", fixture.workspace, "--at", nextAt(), "--project-id", fixture.projectId, "--external-key", "POLICY-ROUNDTRIP", "--title", "Policy roundtrip", "--summary", "Fixture owner policy decision", "--decisions", "Set models.engine-policy for the Codex host.", "--decided-by", "owner:governance", "--actor", "agent:test"], fixture.deviceEnv);
  const policy = { categories: [{ order: 10, id: "main", name: "Main", description: "Everyday work" }], tiers: [{ order: 10, category: "main", runner: "codex", model: "gpt-6.1-sol", effort: "max", note: "original" }], escalation: { enabled: true, threshold: 2, ceiling: "main" }, quota: { fiveHourParallelOffPercent: 70, fiveHourWaitPercent: 85, weeklyParallelOffPercent: 90, weeklyWaitPercent: null } };
  await cli(["engine-model-policy-set", "--workspace", fixture.workspace, "--host", "codex", "--policy", JSON.stringify(policy), "--at", nextAt(), "--actor", "agent:test", "--decided-in", `${meeting.id}#D1`], fixture.deviceEnv);
  const page = await loadExecutedDom(fixture);
  try {
    const { document, window } = page;
    document.querySelector('[data-page-target="engine-model-policy"]').click();
    const view = () => document.querySelector("#engine-model-policy-view");
    const note = () => view().querySelector('[data-engine-policy-kind="tiers"][data-engine-policy-field="note"]');
    assert.equal(view().querySelector('[data-engine-policy-quota="fiveHourParallelOffPercent"]').value, "70");
    assert.equal(view().querySelector('[data-engine-policy-quota="weeklyWaitPercent"]').value, "");
    note().value = "updated";
    note().dispatchEvent(new window.Event("input", { bubbles: true }));
    for (const locale of ["en", "zh-CN", "ja", "ko", "fr"]) {
      document.querySelector(`[data-locale-option="${locale}"]`).click();
      assert.equal(note().value, "updated");
      assert.ok(view().querySelector('select[data-engine-model-policy-host]').getAttribute("aria-label"));
      assert.ok(!view().textContent.includes("modelPolicy."));
      assert.ok(view().querySelector('[data-engine-policy-quota-enabled]').closest("label").textContent.trim());
    }
    view().querySelector('[data-engine-model-policy-save]').click();
    await page.waitForSettled();
    const stored = (await cli(["engine-model-policy-catalog", "--host", "codex"], fixture.deviceEnv)).selectedPolicy;
    assert.deepEqual(stored.quota, policy.quota, "editing another field preserves every quota threshold");
    assert.deepEqual(stored.categories, policy.categories);
    assert.deepEqual(stored.tiers, [{ ...policy.tiers[0], note: "updated" }]);
    assert.deepEqual(stored.escalation, policy.escalation);
    assert.equal(view().querySelector('[data-engine-model-policy-save]').disabled, true);
  } finally { await closePage(page, fixture); }
});



if (!MUTATION) test("INIT-056 variable export controls default private and save explicit targets", async () => {
  const page = await preparePage();
  try {
    const { document } = page;
    document.querySelector('[data-page-target="variables"]').click();
    const row = document.querySelector('[data-variable-create-row]');
    assert.ok([...row.querySelectorAll('[data-variable-export]')].every((control) => !control.checked));
    row.querySelector('[data-variable-field="name"]').value = "delivery.label";
    row.querySelector('[data-variable-field="value"]').value = "Ready";
    row.querySelector('[data-variable-export="handoff"]').checked = true;
    row.querySelector('[data-variable-create]').click();
    await page.waitForSettled();
    const saved = document.querySelector('[data-variable-row="delivery.label"]');
    assert.ok(saved);
    assert.equal(saved.querySelector('[data-variable-export="handoff"]').checked, true);
    assert.equal(saved.querySelector('[data-variable-export="agents"]').checked, false);
  } finally { await page.cleanup(); }
});



if (!MUTATION) test("INIT-056 settings expose central metadata and new controls in five languages", async () => {
  const page = await preparePage();
  try {
    const { document } = page;
    document.querySelector('[data-page-target="settings"]').click();
    for (const locale of ["en", "zh-CN", "ja", "ko", "fr"]) {
      document.querySelector(`[data-locale-option="${locale}"]`).click();
      for (const [group, key, device, scope] of [
        ["general", "agents.generation", false, "project"], ["general", "agents.sharedNavigation", false, "project"],
        ["storage", "paths.artifacts", true, "device"], ["storage", "paths.knowledgeArticles", true, "device"],
        ["execution", "execution.maxConcurrentAgents", true, "device"],
      ]) {
        document.querySelector(`[data-setting-group="${group}"]`).click();
        const row = document.querySelector(`[data-${device ? "machine" : "setting"}-row="${key}"]`);
        assert.ok(row, `${locale}: ${key} exists`);
        assert.ok(!row.textContent.includes(`setting.${key}.`), `${locale}: ${key} is translated`);
        assert.equal(row.querySelector('[data-configuration-contract]')?.dataset.effectiveScope, scope);
        const control = row.querySelector(`[data-${device ? "machine" : "setting"}-control]`);
        assert.ok(control?.getAttribute("aria-label"));
        if (key.startsWith("paths.")) assert.equal(control.tagName, "INPUT", "device path bindings accept literal text");
      }
      document.querySelector('[data-setting-group="models"]').click();
      const compatibility = document.querySelector('[data-setting-row="models.tiers"] [data-configuration-contract]');
      assert.match(compatibility.textContent, /historical-declaration/);
      assert.match(compatibility.textContent, /project-compatibility/);
      assert.match(compatibility.textContent, /device/);
      document.querySelector('[data-setting-group="storage"]').click();
      const path = document.querySelector('[data-setting-control="workspace.generatedArtifactsPath"]');
      assert.equal(path.tagName, "INPUT");
      path.value = "binding:paths.artifacts";
      assert.equal(path.value, "binding:paths.artifacts");
      assert.ok(document.querySelector('[data-configuration-typed-value]'), "typed readback is displayed, not discarded");
    }
  } finally { await page.cleanup(); }
});



if (!MUTATION) test("A546 rules without an output root stay enabled and show a distinct five-locale status", async () => {
  const fixture = await coordinationContainerFixture("tcrn-a546-no-output-", false);
  await cli(["rule-enable", "--project", fixture.coordination, "--id", "autonomy", "--at", nextAt(), "--actor", "agent:test"], { ...fixture.deviceEnv, EINZBERN_SURFACE: "atelier" });
  const page = await loadExecutedDom({ ...fixture, workspace: fixture.coordination });
  const locales = await localeTable();
  try {
    const { document } = page;
    document.querySelector('[data-page-target="prose"]').click();
    for (const locale of ["en", "zh-CN", "ja", "ko", "fr"]) {
      document.querySelector(`[data-locale-option="${locale}"]`).click();
      const card = document.querySelector('[data-rule-card="autonomy"]');
      assert.equal(card.querySelector('[data-rule-state]').dataset.ruleState, "output-unconfigured");
      assert.equal(card.querySelector('[data-rule-state]').textContent, locales[locale]["rule.state.output-unconfigured"]);
      assert.notEqual(card.querySelector('[data-rule-state]').textContent, locales[locale]["rule.state.removed-from-file"]);
      assert.equal(card.querySelector('[data-rule-switch]').checked, true, "the declaration remains enabled without output");
    }
    assert.equal(await readFile(join(fixture.container, "AGENTS.md"), "utf8"), "# The container\n");
    await assert.rejects(readFile(join(fixture.coordination, "AGENTS.md")), { code: "ENOENT" });
  } finally { await closePage(page, fixture); }
});



test("PR24 U2: rejected library selection and failed policy read recover and retry", async () => {
  const fixture = await scratch("tcrn-pr24-failed-switch-");
  const page = await loadExecutedDom(fixture);
  try {
    page.document.querySelector('[data-page-target="engine-model-policy"]').click();
    const { control, change, recovered } = policySwitchControls(page, "#engine-model-policy-view");
    const select = page.document.querySelector("#library-select");
    const option = page.document.createElement("option"); option.value = "not-a-registered-library"; select.append(option);
    change(select, option.value);
    await page.waitForSettled();
    assert.match(page.document.querySelector("#receipt-raw").textContent, /PORTAL_LIBRARY_UNKNOWN/);
    recovered();
    page.hold((path) => path.startsWith("/api/model-policy?"));
    change(select, fixture.second.project);
    await waitFor(() => page.held() === 1, "the switch's pending policy read");
    assert.equal(control("host").disabled, true);
    assert.equal(control("save")?.disabled ?? true, true, "pending read cannot save");
    page.release({ error: new Error("PR24 isolated read failure") });
    await page.waitForSettled();
    assert.equal(control("host").disabled, false, "failed read leaves host available for retry");
    assert.equal(control("save"), null, "unavailable policy has no save action");
    assert.match(page.document.querySelector("#receipt-raw").textContent, /PORTAL_READ_FAILED/);
    change(select, fixture.proseRoot);
    await page.waitForSettled();
    recovered();
  } finally { await closePage(page, fixture); }
});



test("PR24 U2 U3: configuration target switches recover and reject detached Save closures", async () => {
  const fixture = await scratch("tcrn-pr24-scope-switch-");
  const extra = await cli(["project-create", "--workspace", fixture.workspace, "--external-key", "PR24-SCOPE", "--name", "Scope fixture", "--at", nextAt()], fixture.deviceEnv);
  const page = await loadExecutedDom(fixture);
  try {
    page.document.querySelector('[data-page-target="engine-model-policy"]').click();
    const { control, change, recovered } = policySwitchControls(page, "#engine-model-policy-view");
    change(control("decision"), "minutes:synthetic-old#D1", "input");
    const oldSave = control("save");
    const scope = page.document.querySelector("#configuration-project-select");
    page.hold((path) => path.startsWith("/api/model-policy?"));
    change(scope, extra.record.id);
    await waitFor(() => page.held() === 1, "the new scope's policy read");
    assert.equal(control("save").disabled, true, "dirty draft cannot save during the target read");
    oldSave.click();
    assert.equal(page.requests.filter((path) => path === "/api/model-policy").length, 0, "old closure cannot save during the target read");
    page.release();
    await page.waitForSettled();
    assert.equal(scope.disabled, false);
    assert.equal(control("host").disabled, false);
    // Engine policies and decision authority belong to the host/device and
    // library, not to a project configuration scope (engine-model-policy-v1).
    assert.equal(control("decision").value, "minutes:synthetic-old#D1", "same-library scope change preserves the host draft's library-owned decision");
    const before = page.requests.filter((path) => path === "/api/model-policy").length;
    oldSave.click();
    assert.equal(page.requests.filter((path) => path === "/api/model-policy").length, before, "old scope Save cannot submit a draft at the new epoch");
    control("undo").click(); recovered();
    change(control("decision"), "minutes:synthetic-replaced#D1", "input");
    const replacedSave = control("save");
    control("undo").click();
    change(control("decision"), "minutes:synthetic-current#D1", "input");
    replacedSave.click();
    assert.equal(page.requests.filter((path) => path === "/api/model-policy").length, before, "Save cannot submit a different draft created after Undo");
    control("undo").click(); recovered();
    const invalid = page.document.createElement("option"); invalid.value = "project:ffffffffffffffffffffffff"; scope.append(invalid);
    change(scope, invalid.value);
    await page.waitForSettled();
    assert.match(page.document.querySelector("#receipt-raw").textContent, /PORTAL_PROJECT_SCOPE_UNKNOWN/);
    recovered();
    change(scope, fixture.projectId);
    await page.waitForSettled(); recovered();
  } finally { await closePage(page, fixture); }
});



for (const action of ["switch-back", "follow"]) test(`PR24 U2: ${action} after another tab changes selection recovers model controls`, async () => {
  const fixture = await scratch("tcrn-pr24-other-tab-");
  const page = await loadExecutedDom(fixture);
  try {
    page.document.querySelector('[data-page-target="model-tiers"]').click();
    const { recovered } = policySwitchControls(page, "#model-tiers-view");
    const boot = JSON.parse(page.source.match(/const BOOT = (\{[^\n]*\});/u)[1]);
    const response = await page.serverRequest("/api/library", { method: "POST", headers: { "content-type": "application/json", "x-portal-token": boot.token }, body: JSON.stringify({ library: fixture.second.project }) });
    assert.equal(response.status, 200);
    const filter = page.document.querySelector('[data-ui="knowledge-status-filter"]');
    filter.value = "all"; filter.dispatchEvent(new page.window.Event("change", { bubbles: true }));
    await page.waitForSettled();
    const button = page.document.querySelector(`[data-target-${action}]`);
    assert.ok(button);
    button.click();
    await page.waitForSettled();
    recovered();
    assert.equal(page.document.querySelector("#target-notice").hidden, true);
  } finally { await closePage(page, fixture); }
});



// TCRN-CROSS-INIT-053 R46 (I16; EPIC-144 R3): the readiness view lists, for each setting whose value differs
// between the targets, every target's value and where it comes from; "not ready" is information, so its
// badge is the neutral one.
if (!MUTATION) test("R46 I16: a differing setting is listed with each target's value and source, and not ready is neutral", async () => {
  const fixture = await projectChainFixture("tcrn-r46-i16-context-");
  const [, second, third] = fixture.targets;
  await cli(["settings-set", "--workspace", fixture.second.library, "--at", nextAt(), "--actor", "agent:test", "--key", "artifact.language", "--value", "fr"], fixture.atelier);
  await cli(["settings-set", "--workspace", fixture.third.library, "--at", nextAt(), "--actor", "agent:test", "--key", "artifact.language", "--value", "ja"], fixture.atelier);
  const initiative = (await cli(["work-create", "--workspace", fixture.workspace, "--project-id", fixture.projectId, "--at", nextAt(), "--external-key", "R46-I16-CONTEXT", "--kind", "Initiative", "--title", "Two targets of record", "--involved-projects", JSON.stringify({ state: "selected", targets: [second, third] })], fixture.atelier)).record;
  const locales = await localeTable();
  const page = await loadExecutedDom(fixture);
  try {
    const { window } = page;
    const editor = await openWorkEditor(page);
    const work = editor.querySelector("[data-target-work]");
    work.value = initiative.id;
    work.dispatchEvent(new window.Event("change", { bubbles: true }));
    editor.querySelector("[data-target-context]").click();
    const view = await waitFor(() => editor.querySelector("[data-project-context]"), "the readiness view");
    const conflict = view.querySelector('[data-context-conflict="artifact.language"]');
    assert.ok(conflict, "the differing setting is listed");
    const rows = [...conflict.querySelectorAll("[data-context-conflict-target]")].map((row) => [JSON.parse(row.dataset.contextConflictTarget).projectId, row.querySelector("dt").textContent, row.querySelector("[data-context-conflict-value]").textContent, row.querySelector("[data-context-conflict-source]").textContent]);
    const byProject = (left, right) => left[0].localeCompare(right[0]);
    assert.deepEqual([...rows].sort(byProject), [[second.projectId, "TCRN-INC148-DOM-SECOND", "fr", locales.en["scope.thisProject"]], [third.projectId, "TCRN-R45-THIRD", "ja", locales.en["scope.thisProject"]]].sort(byProject), "each target's value and its source");
    assert.ok(conflict.querySelector(".tcrn-machine-token > .tcrn-machine-token__value"), "values use the published MachineToken");
    const readiness = view.querySelector('[data-context-readiness="development"] .tcrn-badge');
    assert.equal(readiness.textContent, locales.en["projects.notReady"]);
    assert.equal(readiness.className, "tcrn-badge", "not ready is the neutral badge");
    assert.equal(view.querySelectorAll("[data-context-readiness] .tcrn-badge--warning").length, 0, "no readiness badge is a warning");
  } finally { await closePage(page, fixture); }
});


for (const [name, selector] of policySwitchViews) test(`PR24 U1: ${name} recovers after a library switch`, async () => {
  const fixture = await scratch("tcrn-pr24-switch-");
  const page = await loadExecutedDom(fixture);
  try {
    page.document.querySelector(`[data-page-target="${name}"]`).click();
    const controls = policySwitchControls(page, selector);
    controls.recovered();
    const before = page.requests.filter((path) => path.startsWith("/api/model-policy?")).length;
    controls.change(page.document.querySelector("#library-select"), fixture.second.project);
    await page.waitForSettled();
    assert.equal(page.document.querySelector("#library-select").disabled, false);
    controls.recovered();
    assert.equal(page.requests.filter((path) => path.startsWith("/api/model-policy?")).length, before + 1, "completion redraw adds no network read");
  } finally { await closePage(page, fixture); }
});



test("PR24 U3: switch completion retains pending write guard and old library draft cannot save", async () => {
  const fixture = await scratch("tcrn-pr24-pending-switch-");
  const page = await loadExecutedDom(fixture);
  try {
    page.document.querySelector('[data-page-target="engine-model-policy"]').click();
    const { control, change, recovered } = policySwitchControls(page, "#engine-model-policy-view");
    change(control("decision"), "minutes:synthetic-old#D1", "input");
    const oldSave = control("save");
    page.hold((path) => path === "/api/model-policy");
    oldSave.click();
    await waitFor(() => page.held() === 1, "the pending isolated write");
    assert.equal(control("save").disabled, true);
    change(page.document.querySelector("#library-select"), fixture.second.project);
    await page.waitForSettled(); recovered();
    change(control("decision"), "minutes:synthetic-new#D1", "input");
    assert.equal(control("save").disabled, true, "write lock survives switching libraries and editing");
    page.release();
    await page.waitForSettled();
    assert.equal(control("decision").value, "minutes:synthetic-new#D1", "old write cannot acknowledge or replace the new library draft");
    assert.equal(control("save").disabled, false, "write completion recovers the new dirty draft without an extra edit");
    const before = page.requests.filter((path) => path === "/api/model-policy").length;
    oldSave.click();
    assert.equal(page.requests.filter((path) => path === "/api/model-policy").length, before, "old library Save cannot submit the new library draft");
  } finally { page.release(); await closePage(page, fixture); }
});

if (!MUTATION) {

  test("TCRN-CROSS-STORY-404 consumes the DS106-112 settings contract and exposes coordination status", async () => {
    const page = await preparePage();
    try {
      // TCRN-CROSS-SUB-409: the retrieval group holds both a NumberInput and a SettingChoice.
      page.document.querySelector('[data-setting-group="retrieval"]')?.click();
      await new Promise((resolve) => setTimeout(resolve, 80));
      const layout = page.document.querySelector('[data-settings-layout-component="SettingsLayout"]');
      assert.ok(layout, "the settings page must consume the DS SettingsLayout contract");
      assert.equal(layout.getAttribute("data-ds-candidate"), `TCRN-Design-System@${DS_CONTRACT.candidate}`);
      assert.equal(layout.getAttribute("data-ds-contract-status"), DS_CONTRACT.reconciliation.status);
      assert.equal(layout.getAttribute("data-ds-contract-version"), "ai_consumption_contract_v1");
      assert.equal(layout.getAttribute("data-ds-contract-digest"), DS_CONTRACT.aiContract.payloadDigest);
      assert.equal(layout.getAttribute("data-ds-surface-contracts"), "overlay-boundary-contract-v1 field-value-selection-contract-v1 dictionary-content-contract-v1 operation-feedback-contract-v1 content-scope-contract-v1 consumer-evidence-contract-v1 verification-cadence-contract-v1");
      assert.equal(layout.getAttribute("data-ds-static-overlay-bridge"), "mountStaticOverlayBoundary");
      assert.deepEqual(layout.getAttribute("data-ds-rules")?.split(" "), ["DS-106-R1", "DS-106-R2", "DS-107-R1", "DS-107-R2", "DS-108-R1", "DS-108-R2", "DS-112-R1", "DS-112-R2", "DS-116-R1", "DS-116-R2", "DS-117-R1", "DS-117-R2", "DS-118-R1", "DS-118-R2", "DS-119-R1", "DS-119-R2"]);
      const required = {
        "data-settings-layout-mode": "container-driven",
        "data-settings-layout-form-policy": "single-host-single-column",
        "data-settings-layout-breakpoint": "960px",
        "data-settings-content-breakpoint": "720px",
        "data-settings-local-navigation": "compact",
        "data-settings-overflow-policy": "no-page-overflow",
        "data-settings-long-value-policy": "native-inline-scroll-copy",
      };
      for (const [attribute, expected] of Object.entries(required)) assert.equal(layout.getAttribute(attribute), expected, `${attribute} must be declared by SettingsLayout`);
      assert.equal(layout.getAttribute("data-settings-layout-navigation-location"), "page-hierarchy-section-tabs");
      assert.ok(layout.querySelector(".tcrn-settings-layout__frame > .tcrn-settings-layout__grid"));
      assert.ok(page.document.querySelector('[data-page-hierarchy-region="section-tabs"] [data-settings-layout-nav]'));
      assert.ok(layout.querySelector(".tcrn-settings-layout__content"));
      const dsStyle = page.document.querySelector('style#tcrn-ds-component-css[data-source="snapshot"]');
      assert.ok(dsStyle?.textContent.includes(".tcrn-setting-choice") && dsStyle.textContent.includes(".tcrn-number-input") && dsStyle.textContent.includes(".tcrn-settings-layout"));
      const numberInputs = [...layout.querySelectorAll('[data-number-input-component="NumberInput"]')];
      assert.ok(numberInputs.length > 0, "the retrieval settings must render DS NumberInput controls");
      assert.ok(numberInputs.every((input) => input.classList.contains("tcrn-number-input")
        && input.classList.contains("tcrn-input")
        && input.type === "number"
        && input.getAttribute("data-number-input") === "true"
        && input.getAttribute("data-number-input-semantic") === "numeric-entry"
        && input.getAttribute("min") !== null
        && input.getAttribute("value") !== null
        && input.getAttribute("data-number-input-visibility") === "full-value"));
      const settingChoices = [...layout.querySelectorAll('[data-setting-choice="true"]')];
      assert.ok(settingChoices.length > 0, "the retrieval settings must render DS SettingChoice markers");
      assert.ok(settingChoices.every((choice) => choice.getAttribute("data-setting-choice-semantic") === "value-selection"
        && ["select", "multi-select"].includes(choice.getAttribute("data-setting-choice-control"))
        && Number.isInteger(Number(choice.getAttribute("data-setting-choice-option-count")))
        && choice.getAttribute("data-setting-choice-rejection-reason") !== null));
      const promptLanguageChoice = layout.querySelector('[data-setting-key="retrieval.promptLanguages"]');
      assert.equal(promptLanguageChoice?.getAttribute("data-setting-choice-control"), "multi-select");
      assert.equal(promptLanguageChoice?.getAttribute("data-setting-choice-rejection-reason"), "collection-closed");
      assert.equal(layout.querySelectorAll(".tcrn-stepper").length, 0, "Stepper must not carry numeric setting semantics");

      // The host switcher and the single host form were the dispatch surface's, which left with
      // the dispatch-* verbs (TCRN-CROSS-STORY-467 R3); the layout contract above is what remains.
      assert.equal(layout.querySelectorAll("[data-dispatch-host-card], [data-settings-host-switcher]").length, 0);
      for (const locale of ["en", "zh-CN", "ja", "ko", "fr"]) {
        page.document.querySelector(`[data-locale-option="${locale}"]`)?.click();
        assert.equal(page.document.documentElement.lang, locale);
        assert.equal(layout.getAttribute("data-settings-layout-component"), "SettingsLayout");
      }
      page.document.querySelector('[data-locale-option="en"]')?.click();
      page.document.querySelector("#theme-button")?.click();
      assert.ok(["light", "dark"].includes(page.document.documentElement.dataset.tcrnTheme));
    } finally { await page.cleanup(); }
  });
}

if (!MUTATION) {

  // TCRN-CROSS-SUB-409 (TCRN-CROSS-STORY-508 R5; MIN-236 D7; contract C-R14-1): the settings page lays
  // every key out by its own catalog row (its group, its order in the group, its layer) and keeps no
  // grouping of its own; SETTING_GROUPS is gone from the page. The retired keys and the prompt-language
  // set of TCRN-CROSS-STORY-409 keep their legs.
  test("SUB-409 (STORY-508 R5): the settings page groups every key by its catalog row, marks its layer, and keeps no grouping of its own", async () => {
    const page = await preparePage();
    try {
      page.document.querySelector('[data-page-target="settings"]')?.click();
      const retiredEconomySettingKey = "model.economyTier";
      assert.doesNotMatch(page.source, /\bSETTING_GROUPS\b/u, "the page's hard-coded key-to-group table is gone");
      const project = (await cli(["settings-catalog", "--workspace", page.workspace], page.deviceEnv)).settings;
      const device = (await cli(["machine-settings-catalog"], { ...page.deviceEnv, HOME: page.fixture.home })).settings;
      const rows = [...project.map((entry) => ({ ...entry })), ...device.map((entry) => ({ ...entry, layer: "device" }))];
      for (const row of rows) {
        assert.equal(page.source.includes(`"${row.key}": "${row.group}"`), false, `${row.key} has no group written into the page`);
        assert.ok(["scalar", "collection"].includes(row.shape) && typeof row.group === "string" && Number.isSafeInteger(row.order), `${row.key} carries its layout`);
      }
      const specificationOrder = ["general", "models", "execution", "knowledge", "retrieval", "storage", "atelier"];
      const groups = [...page.document.querySelectorAll("[data-settings-layout-nav] [data-setting-group]")].map((button) => button.dataset.settingGroup);
      assert.deepEqual(groups, specificationOrder.filter((group) => rows.some((row) => row.group === group)), "the groups are the catalogs' own, in the specification's order");
      const rowKey = (row) => row.dataset.settingRow ?? row.dataset.machineRow;
      const shownRows = () => [...page.document.querySelectorAll("#settings-rows [data-setting-row], #settings-rows [data-machine-row]")];
      for (const group of groups) {
        page.document.querySelector(`[data-setting-group="${group}"]`)?.click();
        const expected = rows.filter((row) => row.group === group).sort((left, right) => left.order - right.order);
        const shown = shownRows();
        assert.deepEqual(shown.map(rowKey), expected.map((row) => row.key), `${group} shows its keys in their catalog order`);
        for (const [index, row] of shown.entries()) {
          assert.equal(row.querySelector("[data-setting-layer]")?.dataset.settingLayer, expected[index].layer, `${expected[index].key} names its layer`);
          const expectedShape = /^(models|quota)\./u.test(expected[index].key) ? "compatibility" : expected[index].shape;
          assert.equal(row.dataset.settingShape, expectedShape, `${expected[index].key} keeps its rendered shape`);
          assert.equal(row.hasAttribute("data-machine-row"), expected[index].layer === "device", `${expected[index].key} is written through its own layer`);
        }
        assert.ok(page.document.querySelector("#settings-count")?.textContent.startsWith(`${expected.length} `), `${group} counts its keys`);
        assert.equal(rows.some((row) => row.key === retiredEconomySettingKey), false);
        assert.equal(page.document.querySelector(`[data-setting-row="${retiredEconomySettingKey}"]`), null, `the retired economy-tier model stays out of ${group}`);
      }

      // The models group is historical compatibility information. It has no project-setting
      // controls and sends each record to the engine-host editor instead of an old collection API.
      page.document.querySelector('[data-setting-group="models"]')?.click();
      for (const key of ["models.category", "models.tiers", "models.escalation.enabled", "models.escalation.threshold", "models.escalation.ceiling"]) {
        const row = page.document.querySelector(`[data-setting-row="${key}"]`);
        assert.equal(row?.dataset.settingShape, "compatibility");
        assert.equal(row.querySelector("[data-setting-control], [data-collection-field]"), null, `${key} has no editor on the settings page`);
        row.querySelector('[data-model-policy-link="engine-model-policy"]').click();
        assert.equal(page.document.querySelector('[data-page="engine-model-policy"]')?.hidden, false, `${key} opens the engine-host editor`);
        page.document.querySelector('[data-page-target="settings"]')?.click();
        page.document.querySelector('[data-setting-group="models"]')?.click();
      }

      // Every row names where it lives, in five languages; in Chinese 项目级（随库同步） or 本机.
      page.document.querySelector('[data-setting-group="knowledge"]')?.click();
      const layerNames = { en: ["Selected project", "This device"], "zh-CN": ["所选项目", "本机"] };
      for (const locale of ["zh-CN", "en", "ja", "ko", "fr"]) {
        page.document.querySelector(`[data-locale-option="${locale}"]`)?.click();
        const names = [...page.document.querySelectorAll("[data-settings-layout-nav] [data-setting-group]")].map((button) => button.textContent.trim());
        assert.ok(names.every((name) => name.length > 0 && !name.startsWith("settings.group.") && !specificationOrder.includes(name)), `${locale} names every group`);
        assert.equal(new Set(names).size, names.length, `${locale} group names are distinct`);
        const projectName = page.document.querySelector('#settings-rows [data-setting-layer="project"]')?.textContent;
        const deviceName = page.document.querySelector('#settings-rows [data-setting-layer="device"]')?.textContent;
        assert.ok(projectName && deviceName && projectName !== deviceName && !projectName.startsWith("settings.layer."), `${locale} names both layers`);
        if (layerNames[locale]) assert.deepEqual([projectName, deviceName], layerNames[locale]);
      }
      page.document.querySelector('[data-locale-option="en"]')?.click();

      // Retirement is a user-visible contract, not only a grouping detail: neither
      // legacy subagent-plan key may produce a settings row, and neither may be
      // discoverable through the global search index.
      page.document.querySelector('[data-setting-group="execution"]')?.click();
      await new Promise((resolve) => setTimeout(resolve, 80));
      for (const key of ["execution.claudeCodeSubagentPlan", "execution.codexSubagentPlan"]) {
        assert.equal(page.document.querySelector(`[data-setting-row="${key}"]`), null, `${key} must stay absent from rendered settings`);
        const globalSearch = page.document.querySelector("#global-search");
        globalSearch.value = key;
        globalSearch.dispatchEvent(new page.window.Event("input", { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 40));
        assert.equal(page.document.querySelectorAll("#search-results [data-search-index]").length, 0, `${key} must stay absent from global search`);
      }

      // All five localized routes keep the same execution controls in their catalog order.
      const expectedExecutionRows = rows.filter((row) => row.group === "execution").sort((left, right) => left.order - right.order).map((row) => row.key);
      for (const locale of ["zh-CN", "en", "ja", "ko", "fr"]) {
        page.document.querySelector(`[data-locale-option="${locale}"]`)?.click();
        await new Promise((resolve) => setTimeout(resolve, 40));
        assert.deepEqual(shownRows().map(rowKey), expectedExecutionRows, `${locale} must keep the execution controls in order`);
      }
      page.document.querySelector('[data-locale-option="en"]')?.click();

      page.document.querySelector('[data-page-target="engine-model-policy"]')?.click();
      const ceiling = page.document.querySelector('[data-engine-policy-escalation="ceiling"]');
      assert.equal(ceiling?.tagName, "SELECT", "the engine policy ceiling cannot fall back to free text");
      assert.equal(ceiling.closest('[data-setting-choice-component]').dataset.settingChoiceSource, "engine-model-policy.categories");

      page.document.querySelector('[data-setting-group="retrieval"]')?.click();
      const prompt = page.document.querySelector('[data-setting-control="retrieval.promptLanguages"]');
      assert.ok(prompt, "prompt languages must have a live control");
      assert.equal(prompt.tagName, "SELECT");
      assert.equal(prompt.multiple || prompt.hasAttribute("multiple"), true);
      assert.equal(prompt.closest("[data-prompt-language-dropdown]").dataset.choicePresentation, "dropdown");
      assert.equal(prompt.getAttribute("data-setting-cardinality"), "set");
      const choice = prompt.closest("[data-setting-choice-component]");
      assert.equal(choice?.getAttribute("data-setting-choice-source"), "artifact.language.allowedValues");
      assert.equal(choice?.getAttribute("data-setting-choice-value-format"), "comma-separated");
      const dropdown = prompt.closest("[data-prompt-language-dropdown]");
      const trigger = dropdown.querySelector('[aria-haspopup="listbox"]');
      assert.equal(trigger.getAttribute("aria-expanded"), "false", "the Select-family trigger starts collapsed");
      const listbox = page.document.getElementById(trigger.getAttribute("aria-controls"));
      assert.ok(listbox && listbox.parentElement === page.document.body, "the published bridge owns a body-level overlay");
      assert.equal(listbox.hidden, true);
      assert.equal(listbox.querySelectorAll('input[type="checkbox"]').length, 0, "the language collection is a dropdown, not a checkbox list");
      const roster = project.find((entry) => entry.key === "artifact.language").allowedValues;
      assert.deepEqual([...prompt.options].map((option) => option.value), roster, "native values and the authority bridge share the real roster");
      trigger.click();
      assert.equal(trigger.getAttribute("aria-expanded"), "true");
      const options = [...listbox.querySelectorAll('[role="option"]')];
      assert.equal(options.length, roster.length);
      assert.match(listbox.textContent, /日本語/u);
      assert.match(listbox.textContent, /한국어/u);
      assert.match(listbox.textContent, /Français/u);
      assert.equal(prompt.closest("[data-setting-row]").querySelector(".tcrn-setting-row__tools [data-reset-setting]"), null, "an inherited default has no override to reset");
      const before = receiptText(page.document);
      // en is the inherited default. A click adds fr locally, then Escape dismisses
      // the list without writing and retains the native focused selection.
      options[roster.indexOf("fr")].click();
      const escape = new page.window.Event("keydown", { bubbles: true });
      Object.defineProperty(escape, "key", { value: "Escape" });
      listbox.dispatchEvent(escape);
      assert.equal(trigger.getAttribute("aria-expanded"), "false");
      assert.deepEqual([...prompt.selectedOptions].map((option) => option.value), ["en", "fr"], "Escape closes the list without discarding the draft");
      assert.equal(choice.querySelector('[data-undo-setting-choice="retrieval.promptLanguages"]').disabled, false, "the retained draft can still be undone");
      assert.equal((await cli(["settings-catalog", "--workspace", page.workspace], page.deviceEnv)).settings.find((entry) => entry.key === "retrieval.promptLanguages").currentValue, null, "an unsaved dropdown is a local draft");
      choice.querySelector('[data-undo-setting-choice="retrieval.promptLanguages"]').click();
      assert.deepEqual([...page.document.querySelector('[data-setting-control="retrieval.promptLanguages"]').selectedOptions].map((option) => option.value), ["en"], "Undo restores the read-back selection");
      const restoredDropdown = page.document.querySelector("[data-prompt-language-dropdown]");
      restoredDropdown.querySelector('[aria-haspopup="listbox"]').click();
      const restoredListbox = page.document.getElementById(restoredDropdown.querySelector('[aria-haspopup="listbox"]').getAttribute("aria-controls"));
      restoredListbox.querySelectorAll('[role="option"]')[roster.indexOf("fr")].click();
      page.document.querySelector('[data-save-setting-choice="retrieval.promptLanguages"]').click();
      await waitFor(receiptAdvanced(page.document, before), "the prompt-language set receipt");
      await page.waitForSettled();
      assert.equal((await cli(["settings-catalog", "--workspace", page.workspace], page.deviceEnv)).settings.find((entry) => entry.key === "retrieval.promptLanguages").currentValue, "en,fr", "a saved selection is unique and serialized in roster order");
      const currentPrompt = page.document.querySelector('[data-setting-control="retrieval.promptLanguages"]');
      for (const option of currentPrompt.options) option.selected = false;
      currentPrompt.dispatchEvent(new page.window.Event("change", { bubbles: true }));
      const beforeClear = receiptText(page.document);
      currentPrompt.closest('[data-setting-choice-component]').querySelector('[data-save-setting-choice="retrieval.promptLanguages"]').click();
      await waitFor(() => receiptText(page.document) !== beforeClear && receiptText(page.document).startsWith("✕"), "the required-selection refusal");
      assert.equal((await cli(["settings-catalog", "--workspace", page.workspace], page.deviceEnv)).settings.find((entry) => entry.key === "retrieval.promptLanguages").currentValue, "en,fr", "empty Save refuses and preserves the last saved value");
      currentPrompt.closest('[data-setting-row]').querySelector('.tcrn-setting-row__tools [data-reset-setting="retrieval.promptLanguages"]').click();
      await page.waitForSettled();
      assert.equal((await cli(["settings-catalog", "--workspace", page.workspace], page.deviceEnv)).settings.find((entry) => entry.key === "retrieval.promptLanguages").currentValue, null, "explicit Reset restores inheritance");
    } finally { await page.cleanup(); }
  });
}

if (!MUTATION) {

  // TCRN-CROSS-SUB-409 (TCRN-CROSS-STORY-508 R6): the former project-model collection
  // destinations now render a single engine-host policy through the existing table components.
  test("SUB-409 (STORY-508 R6): model category and tier pages edit the selected engine host, not project settings", async () => {
    const page = await preparePage();
    try {
      const { document, window } = page;
      const categoryTable = () => document.querySelector('[data-collection-table="engine-model-policy-categories"]');
      const tierTable = () => document.querySelector('[data-collection-table="engine-model-policy-tiers"]');
      const columns = (table) => [...table.querySelectorAll("[data-collection-column]")].map((column) => column.dataset.collectionColumn);
      document.querySelector('[data-page-target="model-categories"]').click();
      assert.deepEqual(columns(categoryTable()), ["order", "id", "name", "description", "actions"]);
      assert.equal(categoryTable().getAttribute("data-collection-component"), "CollectionTable");
      assert.equal(document.querySelector('[data-collection-save="models.category"]'), null, "the category page has no legacy settings write");
      categoryTable().querySelector('[data-engine-policy-add="categories"]').click();
      const category = (field) => categoryTable().querySelector('[data-engine-policy-kind="categories"][data-engine-policy-index="0"][data-engine-policy-field="' + field + '"]');
      for (const [field, value] of [["id", "main"], ["name", "Main"], ["description", "Host policy category"]]) {
        category(field).value = value;
        category(field).dispatchEvent(new window.Event("input", { bubbles: true }));
      }
      document.querySelector('[data-page-target="model-tiers"]').click();
      assert.deepEqual(columns(tierTable()), ["order", "category", "runner", "model", "effort", "note", "actions"]);
      assert.equal(tierTable().getAttribute("data-collection-component"), "CollectionTable");
      assert.equal(document.querySelector('[data-collection-save="models.tiers"]'), null, "the tier page has no legacy settings write");
      const addTier = tierTable().querySelector('[data-engine-policy-add="tiers"]');
      assert.equal(addTier.disabled, false, "the selected host's draft category enables its tier action");
      addTier.click();
      const categoryChoice = tierTable().querySelector('[data-engine-policy-kind="tiers"][data-engine-policy-index="0"][data-engine-policy-field="category"]');
      assert.deepEqual([...categoryChoice.querySelectorAll("option")].map((option) => option.value), ["main"], "the engine-host category table supplies the tier reference choices");
      assert.equal(categoryChoice.value, "main");
      document.querySelector('[data-page-target="engine-model-policy"]').click();
      assert.ok(document.querySelector('[data-engine-model-policy-save][data-cli-action="engine-model-policy-set"]'), "all three views use the governed engine-policy write");
      for (const locale of ["en", "zh-CN", "ja", "ko", "fr"]) {
        document.querySelector('[data-locale-option="' + locale + '"]').click();
        assert.ok(categoryTable()?.querySelector('[data-collection-column="order"]')?.textContent.trim(), locale + " names the category order column");
        assert.ok(tierTable()?.querySelector('[data-collection-column="order"]')?.textContent.trim(), locale + " names the tier order column");
      }
      document.querySelector('[data-locale-option="en"]').click();
      assert.equal(document.querySelector("#save-agents").getAttribute("data-cli-action"), "rule-list");
      assert.doesNotMatch(page.source, /agents-render/u);
    } finally { await page.cleanup(); }
  });
}

if (!MUTATION) {

  // TCRN-CROSS-SUB-409 (TCRN-CROSS-STORY-508 R6): host-policy tier drafts are ordinary
  // table rows, but their write path is the engine policy endpoint and never settings-set.
  test("SUB-409 (STORY-508 R6): tier drafts use the selected engine host and Undo has no policy-delete side effect", async () => {
    const page = await preparePage();
    try {
      const { document, window } = page;
      const legacyBefore = await cli(["settings-catalog", "--workspace", page.workspace], page.deviceEnv);
      const legacyTiers = legacyBefore.settings.find((entry) => entry.key === "models.tiers").currentValue;
      const view = () => document.querySelector("#engine-model-policy-view");
      const categories = () => view().querySelector('[data-engine-model-policy-section="categories"]');
      const tiers = () => view().querySelector('[data-engine-model-policy-section="tiers"]');
      const input = (kind, index, field) => view().querySelector('[data-engine-policy-kind="' + kind + '"][data-engine-policy-index="' + index + '"][data-engine-policy-field="' + field + '"]');
      document.querySelector('[data-page-target="engine-model-policy"]').click();
      view().querySelector('[data-engine-policy-add="categories"]').click();
      for (const [field, value] of [["id", "main"], ["name", "Main"]]) {
        input("categories", 0, field).value = value;
        input("categories", 0, field).dispatchEvent(new window.Event("input", { bubbles: true }));
      }
      view().querySelector('[data-engine-policy-add="tiers"]').click();
      for (const [field, value] of [["runner", "codex"], ["model", "gpt-5.6-terra"], ["effort", "max"], ["note", "draft only"]]) {
        input("tiers", 0, field).value = value;
        input("tiers", 0, field).dispatchEvent(new window.Event("input", { bubbles: true }));
      }
      assert.equal(categories().querySelectorAll('[data-collection-row]').length, 1);
      assert.equal(tiers().querySelectorAll('[data-collection-row]').length, 1);
      assert.equal(input("tiers", 0, "category").value, "main");
      assert.equal(view().querySelectorAll('[data-engine-policy-remove="tiers"]').length, 1, "a draft row can be removed before save");
      assert.equal(document.querySelector('[data-cli-action="settings-set"][data-collection-save="models.tiers"]'), null, "tiers have no legacy collection writer");
      view().querySelector('[data-engine-model-policy-undo]').click();
      assert.equal(view().querySelectorAll('[data-collection-row]').length, 0, "Undo returns an unconfigured host to its empty draft");
      const legacyAfter = await cli(["settings-catalog", "--workspace", page.workspace], page.deviceEnv);
      assert.equal(legacyAfter.settings.find((entry) => entry.key === "models.tiers").currentValue, legacyTiers, "draft and Undo leave historical project data untouched");
    } finally { await page.cleanup(); }
  });
}

if (!MUTATION) {

  // TCRN-CROSS-SUB-409 (TCRN-CROSS-STORY-508 R1, R6): category ids and the tier relation are
  // edited together in the selected host draft, with labels owned by the actual controls.
  test("SUB-409 (STORY-508 R1, R6): engine policy category choices and table action names remain accessible", async () => {
    const page = await preparePage();
    try {
      const { document, window } = page;
      const view = () => document.querySelector("#engine-model-policy-view");
      const input = (kind, index, field) => view().querySelector('[data-engine-policy-kind="' + kind + '"][data-engine-policy-index="' + index + '"][data-engine-policy-field="' + field + '"]');
      const write = (node, value, event = "input") => { node.value = value; node.dispatchEvent(new window.Event(event, { bubbles: true })); };
      document.querySelector('[data-page-target="engine-model-policy"]').click();
      for (const [index, id, name] of [[0, "main", "Main"], [1, "review", "Review"]]) {
        view().querySelector('[data-engine-policy-add="categories"]').click();
        write(input("categories", index, "id"), id);
        write(input("categories", index, "name"), name);
      }
      view().querySelector('[data-engine-policy-add="tiers"]').click();
      const headers = [...view().querySelector('[data-collection-table="engine-model-policy-categories"]').querySelectorAll("[data-collection-column]")].map((node) => node.dataset.collectionColumn);
      assert.deepEqual(headers, ["order", "id", "name", "description", "actions"], "the name field has its own header and actions remains last");
      const choice = input("tiers", 0, "category");
      assert.deepEqual([...choice.querySelectorAll("option")].map((option) => option.value), ["main", "review"]);
      assert.equal(choice.getAttribute("aria-label"), choice.closest('[role="cell"]').getAttribute("data-label"));
      for (const control of view().querySelectorAll('[data-engine-policy-field], [data-engine-policy-escalation]')) {
        if (control.type === "checkbox") assert.ok(control.closest("label")?.textContent.trim(), "the switch has its visible label");
        else assert.ok(control.getAttribute("aria-label")?.trim(), "every policy input has an accessible name");
      }
      for (const button of view().querySelectorAll('[data-engine-policy-remove]')) {
        assert.ok(button.getAttribute("aria-label")?.trim(), "row actions have accessible names");
        assert.equal(button.type, "button", "row actions do not submit an unrelated form");
      }
      write(choice, "review", "change");
      assert.equal(input("tiers", 0, "category").value, "review", "the selected category is preserved after rendering");
    } finally { await page.cleanup(); }
  });
}

if (!MUTATION) {

  // TCRN-CROSS-SUB-409 (TCRN-CROSS-STORY-508 R6): an unconfigured engine host can create
  // its first policy category; there is no project-table precondition or invented delete endpoint.
  test("SUB-409 (STORY-508 R6): an empty engine host guides the reader to its first policy category", async () => {
    const page = await preparePage();
    try {
      const { document } = page;
      document.querySelector('[data-page-target="engine-model-policy"]').click();
      const view = () => document.querySelector("#engine-model-policy-view");
      const categoryTable = () => view().querySelector('[data-collection-table="engine-model-policy-categories"]');
      const tierTable = () => view().querySelector('[data-collection-table="engine-model-policy-tiers"]');
      for (const table of [categoryTable(), tierTable()]) {
        assert.ok(table.querySelector('[data-collection-column="order"]'), "an empty policy table retains its order column");
        assert.ok(table.querySelector("[data-collection-empty] .tcrn-state-surface__description")?.textContent.trim(), "an empty policy table explains its next action");
      }
      assert.ok(categoryTable().querySelector('[data-engine-policy-add="categories"]'), "an empty host offers its first category action");
      assert.equal(tierTable().querySelector('[data-engine-policy-add="tiers"]')?.disabled, true, "a tier waits for an actual host-policy category");
      for (const locale of ["en", "zh-CN", "ja", "ko", "fr"]) {
        document.querySelector('[data-locale-option="' + locale + '"]').click();
        const guide = categoryTable().querySelector("[data-collection-empty]");
        assert.ok(guide.textContent.trim() && !guide.textContent.includes("modelPolicy."), locale + " translates the first-policy guide");
      }
      document.querySelector('[data-locale-option="en"]').click();
      categoryTable().querySelector('[data-engine-policy-add="categories"]').click();
      assert.equal(tierTable().querySelector('[data-engine-policy-add="tiers"]')?.disabled, false, "the first category unlocks an in-memory tier draft");
      assert.equal(document.querySelector('[data-cli-action="engine-model-policy-remove"]'), null, "the UI invents no policy-delete API");
    } finally { await page.cleanup(); }
  });
}

if (!MUTATION) {

  // TCRN-CROSS-SUB-410 (TCRN-CROSS-STORY-508 R7; contract C-R14-5): the variables, rules and gates pages
  // each carry an order in the same NumberInput, under a header that says what it orders: the render
  // order of AGENTS.md for variables and rules, the plan and display order for gates. Each lists its
  // records in that order, and an order changed on the page is written by the engine and read back.
  test("SUB-410 (STORY-508 R7): variables, rules and gates each show their order, say what it orders, and write it through the engine", async () => {
    const fixture = await scratch("tcrn-410-orders-");
    const atelier = { ...fixture.deviceEnv, EINZBERN_SURFACE: "atelier" };
    const write = (command, args) => cli([command, "--workspace", fixture.workspace, "--at", nextAt(), "--actor", "agent:test", ...args], atelier);
    await write("variable-set", ["--exports", "agents", "--name", "alpha", "--type", "string", "--value", "a"]);
    await write("variable-set", ["--exports", "agents", "--name", "beta", "--type", "string", "--value", "b", "--order", "5"]);
    await write("gates-config-set", ["--name", "lint", "--command", JSON.stringify(["node", "--version"])]);
    await write("gates-config-set", ["--name", "unit", "--command", JSON.stringify(["node", "--version"]), "--order", "4"]);
    for (const [id, order] of [["batch", ["--order", "3"]], ["autonomy", []]]) {
      await cli(["rule-enable", "--project", fixture.proseRoot, "--id", id, ...order, "--at", nextAt(), "--actor", "agent:test"], atelier);
    }
    // Every rule the engine lists, in its order; the ones without an order follow the ordered ones in that order.
    const engineRules = (await cli(["rule-list", "--project", fixture.proseRoot], fixture.deviceEnv)).rules.map((rule) => rule.id);
    const withoutOrder = (...ordered) => engineRules.filter((id) => !ordered.includes(id)).map((id) => [id, ""]);
    const page = await loadExecutedDom(fixture);
    const document = page.document;
    const agents = () => readFile(join(fixture.proseRoot, "AGENTS.md"), "utf8");
    const type = (input, value) => { input.value = value; input.dispatchEvent(new page.window.Event("input", { bubbles: true })); };
    const act = async (element) => { element.click(); await page.waitForSettled(); return receiptText(document); };
    const variableRows = () => [...document.querySelectorAll("[data-variable-row]")].map((row) => [row.dataset.variableRow, row.querySelector('[data-variable-field="order"]').value]);
    const gateRows = () => [...document.querySelectorAll("[data-gate-row]")].map((row) => [row.dataset.gateRow, row.querySelector("[data-gate-order]").value]);
    const ruleCards = () => [...document.querySelectorAll("[data-rule-card]")].map((card) => [card.dataset.ruleCard, card.querySelector("[data-rule-order]").value]);
    try {
      // Each page lists its records as the engine renders or plans them, each order in a NumberInput.
      assert.deepEqual(variableRows(), [["beta", "5"], ["alpha", ""]]);
      assert.deepEqual(gateRows(), [["unit", "4"], ["lint", ""]]);
      assert.ok(engineRules.includes("silent-reporting") && engineRules.includes("unattended-commands"), "the engine lists its built-in rules");
      assert.deepEqual(ruleCards(), [["batch", "3"], ...withoutOrder("batch")]);
      const orderInputs = [...document.querySelectorAll('[data-variable-row] [data-variable-field="order"], [data-gate-row] [data-gate-order], [data-rule-card] [data-rule-order]')];
      assert.ok(orderInputs.length === 2 + 2 + engineRules.length && orderInputs.every((input) => input.getAttribute("data-number-input-component") === "NumberInput" && input.type === "number" && input.getAttribute("min") === "1"));
      // An enabled rule saves its order; a disabled one takes it when it is switched on.
      assert.ok(document.querySelector('[data-rule-card="batch"] [data-rule-order-save][data-cli-action="rule-enable"]'));
      assert.equal(document.querySelector('[data-rule-card="silent-reporting"] [data-rule-order-save]'), null);
      assert.equal(document.querySelector('[data-rule-card="silent-reporting"] [data-rule-order]').disabled, false);

      // Five languages: each page's header says what its order is for, and the order column is named.
      const orderNames = { en: "Order", "zh-CN": "顺序", ja: "順序", ko: "순서", fr: "Ordre" };
      for (const [locale, orderName] of Object.entries(orderNames)) {
        document.querySelector(`[data-locale-option="${locale}"]`)?.click();
        for (const purpose of ["variables", "rules", "gates"]) {
          const text = document.querySelector(`.tcrn-page__lede[data-order-purpose="${purpose}"]`).textContent;
          assert.ok(text.toLocaleLowerCase().includes(orderName.toLocaleLowerCase()) && text.includes(purpose === "gates" ? "" : "AGENTS.md"), `${locale} ${purpose}: the header says what the order is for`);
        }
        assert.equal(document.querySelector("[data-variable-table] [role=columnheader]").textContent, orderName);
        assert.equal(document.querySelector('[data-ui="gate-config-table"] [role=columnheader]').textContent, orderName);
        assert.equal(document.querySelector('[data-rule-card="batch"] [data-rule-card-order] .tcrn-field__label').textContent, orderName);
      }
      document.querySelector('[data-locale-option="en"]')?.click();

      // Variables: an order moves the variable in the table and in the custom section; an empty one clears it.
      document.querySelector('[data-page-target="variables"]').click();
      for (const input of document.querySelectorAll('[data-variable-field], [data-variable-create]')) {
        if (!input.matches("input,select,textarea")) continue;
        assert.equal(input.getAttribute("aria-label"), input.closest('[role="cell"]').getAttribute("data-label"));
        assert.ok(input.getAttribute("aria-label"));
      }
      type(document.querySelector('[data-variable-row="alpha"] [data-variable-field="order"]'), "2");
      assert.match(await act(document.querySelector('[data-variable-row="alpha"] [data-variable-save]')), /^✓v\d+$/u);
      assert.deepEqual(variableRows(), [["alpha", "2"], ["beta", "5"]]);
      assert.ok((await agents()).indexOf("| alpha |") < (await agents()).indexOf("| beta |"), "the custom section follows the order");
      type(document.querySelector('[data-variable-row="beta"] [data-variable-field="order"]'), "");
      assert.match(await act(document.querySelector('[data-variable-row="beta"] [data-variable-save]')), /^✓v\d+$/u);
      const variables = (await cli(["variable-list", "--workspace", fixture.workspace], fixture.deviceEnv)).variables;
      assert.deepEqual(variables.map((variable) => [variable.name, variable.order ?? null]), [["alpha", 2], ["beta", null]]);
      assert.deepEqual(variableRows(), [["alpha", "2"], ["beta", ""]]);

      // Gates: the engine judges the order; a refused one records nothing, an accepted one reorders the plan.
      document.querySelector('[data-page-target="gates"]').click();
      // The DOM harness reads a parsed textarea's text still escaped and a parsed checkbox as neither
      // checked nor unchecked, so the row is given its command and switches as a reader's browser holds them.
      const command = () => {
        const row = document.querySelector('[data-gate-row="lint"]');
        row.querySelector("[data-gate-command]").value = JSON.stringify(["node", "--version"]);
        for (const [field, checked] of [["required", true], ["enabled", true], ["release-only", false]]) row.querySelector(`[data-gate-${field}]`).checked = checked;
      };
      command();
      type(document.querySelector('[data-gate-row="lint"] [data-gate-order]'), "0");
      assert.match(await act(document.querySelector('[data-gate-save="lint"]')), /^✕/u);
      assert.match(document.querySelector("#receipt-body")?.textContent ?? "", /CLI_ARGUMENT_MALFORMED/u);
      command();
      type(document.querySelector('[data-gate-row="lint"] [data-gate-order]'), "2");
      assert.match(await act(document.querySelector('[data-gate-save="lint"]')), /^✓v\d+$/u);
      assert.deepEqual(gateRows(), [["lint", "2"], ["unit", "4"]]);
      const gates = (await cli(["gates-config-list", "--workspace", fixture.workspace], fixture.deviceEnv)).records;
      assert.deepEqual(gates.map((gate) => [gate.name, gate.order ?? null]), [["lint", 2], ["unit", 4]]);

      // Rules: an enabled rule's saved order moves its section; a disabled rule switched on takes its order.
      document.querySelector('[data-page-target="prose"]').click();
      type(document.querySelector('[data-rule-order="autonomy"]'), "1");
      assert.match(await act(document.querySelector('[data-rule-order-save="autonomy"]')), /^✓v\d+$/u);
      assert.deepEqual(ruleCards().slice(0, 2), [["autonomy", "1"], ["batch", "3"]]);
      const moved = await agents();
      assert.ok(moved.indexOf("rule:autonomy") < moved.indexOf("rule:batch"), "the rule sections follow the order");
      assert.equal(document.querySelector("#agents-md").value, moved, "the editor reads AGENTS.md back");
      type(document.querySelector('[data-rule-order="silent-reporting"]'), "2");
      const toggle = document.querySelector('[data-rule-switch="silent-reporting"]');
      toggle.checked = true;
      toggle.dispatchEvent(new page.window.Event("change", { bubbles: true }));
      await page.waitForSettled();
      assert.deepEqual(ruleCards(), [["autonomy", "1"], ["silent-reporting", "2"], ["batch", "3"], ...withoutOrder("autonomy", "silent-reporting", "batch")]);
      const listed = (await cli(["rule-list", "--project", fixture.proseRoot], fixture.deviceEnv)).rules;
      assert.deepEqual(listed.filter((rule) => rule.order !== undefined).map((rule) => [rule.id, rule.state, rule.order]), [["autonomy", "enabled", 1], ["batch", "enabled", 3], ["silent-reporting", "enabled", 2]]);
      const text = await agents();
      assert.ok(text.indexOf("rule:autonomy") < text.indexOf("rule:silent-reporting") && text.indexOf("rule:silent-reporting") < text.indexOf("rule:batch"), "a rule switched on with an order takes its place");
    } finally { page.child.kill(); await rm(fixture.base, { recursive: true, force: true }); }
  });
}

if (!MUTATION) {

  // TCRN-CROSS-SUB-410 (TCRN-CROSS-STORY-508 R6): escalation belongs to the selected
  // engine-host policy and is edited with its categories and tiers, not through legacy settings rows.
  test("SUB-410 (STORY-508 R6): the tier page edits escalation in the governed engine-host policy", async () => {
    const page = await preparePage();
    try {
      const { document, window } = page;
      document.querySelector('[data-page-target="model-categories"]').click();
      document.querySelector('[data-engine-policy-add="categories"]').click();
      const categoryId = document.querySelector('[data-engine-policy-kind="categories"][data-engine-policy-index="0"][data-engine-policy-field="id"]');
      categoryId.value = "main";
      categoryId.dispatchEvent(new window.Event("input", { bubbles: true }));
      document.querySelector('[data-page-target="model-tiers"]').click();
      const escalation = document.querySelector('[data-engine-model-policy-section="escalation"]');
      assert.ok(escalation, "the engine policy tier page renders escalation with its host data");
      const enabled = escalation.querySelector('[data-engine-policy-escalation="enabled"]');
      const threshold = escalation.querySelector('[data-engine-policy-escalation="threshold"]');
      const ceiling = escalation.querySelector('[data-engine-policy-escalation="ceiling"]');
      assert.equal(enabled.getAttribute("role"), "switch");
      assert.equal(threshold.type, "number");
      assert.equal(ceiling.tagName, "SELECT");
      assert.deepEqual([...ceiling.querySelectorAll("option")].map((option) => option.value), ["main"]);
      threshold.value = "3";
      threshold.dispatchEvent(new window.Event("input", { bubbles: true }));
      assert.equal(document.querySelector('[data-engine-model-policy-save]')?.disabled, false, "an escalation edit makes the one governed host save available");
      document.querySelector('[data-page-target="settings"]').click();
      document.querySelector('[data-setting-group="models"]').click();
      assert.equal(document.querySelector('[data-setting-control="models.escalation.threshold"]'), null, "legacy escalation settings are not a second writable surface");
    } finally { await page.cleanup(); }
  });
}

if (!MUTATION) {

  // STORY-373 replaced the model page and its directory with the dispatch surface, which then
  // left with the dispatch-* verbs (TCRN-CROSS-STORY-467 R3). None of the three may come back.
  test("STORY-373/467 the model page, its directory and the dispatch surface are all absent", async () => {
    const page = await preparePage();
    try {
      // TCRN-CROSS-SUB-409 (STORY-508 R5): "models" is the catalog's models and escalation group now. It
      // lists the catalog's models keys and nothing of the retired model plans.
      page.document.querySelector('[data-setting-group="models"]')?.click();
      const modelsKeys = (await cli(["settings-catalog", "--workspace", page.workspace], page.deviceEnv)).settings.filter((entry) => entry.group === "models").map((entry) => entry.key).sort();
      assert.deepEqual([...page.document.querySelectorAll("#settings-rows [data-setting-row], #settings-rows [data-machine-row]")].map((row) => row.dataset.settingRow ?? row.dataset.machineRow).sort(), modelsKeys);
      assert.equal(page.document.querySelector("#model-plans"), null);
      assert.equal(page.document.querySelector('[data-ui="vendor-directory-toggle"]'), null);
      assert.equal(page.document.querySelector('[data-ui="vendor-directory-drawer"]'), null);
      assert.equal(page.document.querySelector('[data-ui="dispatch-config-surface"]'), null);
      assert.equal(page.document.querySelectorAll("[data-dispatch-tier-row], [data-dispatch-mode-select], [data-dispatch-probe]").length, 0);
      assert.doesNotMatch(page.source, /api\/execution|dispatch-[a-z]+-(?:set|list)/u);
    } finally { await page.cleanup(); }
  });
}

if (!MUTATION) {

  // STORY-355 GWT3. Evidence boundary, stated plainly rather than overclaimed: this
  // proves the toggle exists, that clicking it flips the two state attributes the CSS
  // keys off (.tcrn-shell-mobile-nav-toggle and the data-mobile-nav-expanded rule
  // inside the 760px block), and that all live nav destinations still reach their
  // section through it. It does NOT prove the CSS actually shows or hides anything at
  // that breakpoint -- linkedom parses and executes script but never runs layout or
  // media queries (INC-148's "against a parsed, executed DOM", not a rendered one).
  // The closest this harness gets to that half of the contract is the static text
  // check of the two rules at the end, which is not a rendering assertion either.
  test("STORY-355 GWT3: the mobile nav toggle flips its state attributes, every destination stays reachable through it, and the 760px rules that gate it are present", async () => {
    const page = await preparePage();
    try {
      const shell = page.document.querySelector(".tcrn-product-shell");
      const toggle = page.document.querySelector("#mobile-nav-toggle");
      const nav = page.document.querySelector("#primary-side-nav");
      assert.ok(shell && toggle && nav, "the shell must expose the mobile nav toggle and the nav it controls");
      assert.equal(toggle.getAttribute("aria-controls"), "primary-side-nav");
      assert.equal(toggle.getAttribute("aria-expanded"), "false");
      assert.equal(shell.getAttribute("data-mobile-nav-expanded"), null, "closed is the unset default -- a server render needs no script to start correct");

      toggle.dispatchEvent(new page.window.Event("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 40));
      assert.equal(shell.getAttribute("data-mobile-nav-expanded"), "true");
      assert.equal(toggle.getAttribute("aria-expanded"), "true");

      // The live destinations the CSS puts behind this toggle at narrow widths still
      // drive the same section router the always-visible desktop nav always used.
      const destinations = ["dashboard", "settings", "model-categories", "model-tiers", "prose", "vocabulary"];
      for (const target of destinations) {
        const navItem = nav.querySelector(`[data-page-target="${target}"]`);
        assert.ok(navItem, `the expanded nav must still carry the ${target} destination`);
        navItem.dispatchEvent(new page.window.Event("click", { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 40));
        for (const section of [...page.document.querySelectorAll("[data-page]")]) {
          assert.equal(section.hidden, section.dataset.page !== target, `[data-page="${section.dataset.page}"] hidden must follow the ${target} navigation`);
        }
      }

      toggle.dispatchEvent(new page.window.Event("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 40));
      assert.equal(shell.getAttribute("data-mobile-nav-expanded"), "false");
      assert.equal(toggle.getAttribute("aria-expanded"), "false");

      const css = page.document.querySelector('style#tcrn-ds-component-css[data-source="snapshot"]')?.textContent ?? "";
      assert.match(css, /@media \(max-width: 760px\)[\s\S]*?\.tcrn-shell-mobile-nav-toggle\s*\{[\s\S]*?display:\s*inline-flex/u,
        "the mobile toggle must become visible inside the 760px breakpoint");
      assert.match(css, /@media \(max-width: 760px\)[\s\S]*?data-mobile-nav-expanded="true"[\s\S]*?\.tcrn-side-nav\s*\{[\s\S]*?display:\s*grid/u,
        "the expanded attribute must be what reveals the side nav inside the 760px breakpoint");
    } finally { await page.cleanup(); }
  });
}



// TCRN-CROSS-STORY-541 GWT2, GWT3 (MIN-258 D3; TCRN-CROSS-SUB-513): the Library tab declares the selected library's
// chain identity after a confirmation and takes a registry entry out after its plan is shown and confirmed; the
// Gates page lists a migrated gate and releases it only with a reason, after a confirmation, and then shows who
// released it, when and why.
if (!MUTATION) test("541 SUB-513: the Library tab declares the chain identity and removes a registry entry after its plan, and the Gates page releases a migrated gate with a reason", async () => {
  const fixture = await scratch("tcrn-541-panels-");
  await asFixtureDevice(fixture, () => appendHistoricalGateCreate(fixture.workspace, { externalKey: "TCRN-541-UI-GATE", projectId: fixture.projectId, workId: null, title: "Migrated owner gate", outcomeClass: "owner_intent_required", occurredAt: nextAt().replace(/\.\d{3}Z$/u, "Z") }));
  const locales = await localeTable();
  const page = await loadExecutedDom(fixture);
  try {
    const { document, window } = page;
    const receiptAdvanced = (before) => () => receiptText(document) !== before;
    document.querySelector('[data-page-target="dashboard"]')?.click();
    document.querySelector('[data-workspace-tab="library"]')?.click();
    assert.equal(document.querySelector('[data-workspace-panel="library"]')?.hidden, false, "the Library tab opens its panel");
    const libraryId = (await cli(["status", "--workspace", fixture.workspace], fixture.deviceEnv)).workspaceId;

    // The chain identity: none yet, and no coordination library registered for a project library to belong to.
    const form = document.querySelector('[data-ui="chain-declare-form"]');
    await waitFor(() => document.querySelector("#chain-identity-current")?.textContent === locales.en["chainIdentity.undeclared"], "the undeclared identity");
    assert.equal(form.querySelector("[data-chain-role]").value, "project");
    assert.equal(form.querySelector("[data-chain-no-coordination]").hidden, false);
    assert.equal(form.querySelector('button[type="submit"][data-cli-action="chain-declare"]').disabled, true);
    const role = form.querySelector("[data-chain-role]");
    role.value = "coordination";
    role.dispatchEvent(new window.Event("change", { bubbles: true }));
    assert.deepEqual([...form.querySelectorAll("[data-chain-coordination] option")].map((option) => option.value), [libraryId], "a coordination library belongs to itself");
    form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    const confirm = document.querySelector('[data-ui="chain-declare-confirm"]');
    assert.equal(confirm.hidden, false, "the declaration waits for a confirmation");
    assert.equal(document.querySelector("#chain-declare-summary").textContent, locales.en["chainIdentity.confirmText"].replace("{role}", locales.en["chainIdentity.roleCoordination"]).replace("{library}", document.querySelector("[data-chain-coordination] option").textContent));
    assert.equal((await cli(["chain-identity", "--workspace", fixture.workspace], fixture.deviceEnv)).identity, null, "nothing is declared before the confirmation");
    let before = receiptText(document);
    confirm.querySelector("[data-chain-declare-confirm]").click();
    await waitFor(receiptAdvanced(before), "the chain-declare receipt");
    await page.waitForSettled();
    assert.deepEqual((await cli(["chain-identity", "--workspace", fixture.workspace], fixture.deviceEnv)).identity, { role: "coordination", coordinationLibraryId: libraryId });
    assert.equal(confirm.hidden, true);
    assert.ok(document.querySelector("#chain-identity-current").textContent.startsWith(locales.en["chainIdentity.roleCoordination"]), "the tab shows the declared role");

    // The registry: the selected entry cannot be removed; another one is, after its plan.
    const entry = (path) => document.querySelector(`[data-registry-entry="${path}"]`);
    await waitFor(() => entry(fixture.second.project)?.querySelector("[data-library-unregister]"), "the registry list");
    assert.ok(entry(fixture.proseRoot).querySelector("[data-registry-selected]"), "the selected entry says it cannot be removed");
    assert.equal(entry(fixture.proseRoot).querySelector("[data-library-unregister]"), null);
    assert.equal(entry(fixture.second.project).querySelectorAll('[data-path-exists="true"]').length, 2, "both paths of the entry exist");
    before = receiptText(document);
    entry(fixture.second.project).querySelector("[data-library-unregister]").click();
    const plan = await waitFor(() => document.querySelector(`[data-registry-plan="${fixture.second.project}"]`), "the unregister plan");
    assert.match(plan.textContent, /library-unregister|registry\.json/u);
    assert.equal((await cli(["library-list"], fixture.deviceEnv)).entries.length, 2, "the plan removes nothing");
    plan.querySelector("[data-library-unregister-confirm]").click();
    await waitFor(() => entry(fixture.second.project) === null, "the entry to leave the list");
    assert.deepEqual((await cli(["library-list"], fixture.deviceEnv)).entries.map((item) => item.projectPath), [fixture.proseRoot]);
    assert.equal(document.querySelectorAll("#library-select option").length, 1, "the switcher follows the registry");

    // The migrated gate: listed, refused without a reason, released after a confirmation.
    document.querySelector('[data-page-target="gates"]')?.click();
    const gateRow = await waitFor(() => document.querySelector("#migrated-gates-list [data-migrated-gate]"), "the migrated gate");
    const gateId = gateRow.dataset.migratedGate;
    assert.equal(gateRow.querySelector("[data-migrated-gate-status]").textContent, locales.en["migratedGates.pending"]);
    gateRow.querySelector("[data-gate-release]").click();
    assert.equal(gateRow.querySelector("[data-gate-release-error]").hidden, false, "a release without a reason is not sent");
    assert.equal(gateRow.querySelector("[data-gate-release-reason]").getAttribute("aria-invalid"), "true");
    const reason = gateRow.querySelector("[data-gate-release-reason]");
    reason.value = "The Owner accepted the Story by hand.";
    reason.dispatchEvent(new window.Event("input", { bubbles: true }));
    gateRow.querySelector("[data-gate-release]").click();
    const confirming = document.querySelector(`[data-gate-release-confirming="${gateId}"]`);
    assert.ok(confirming, "the release waits for a confirmation");
    assert.equal((await cli(["work-gate-list", "--workspace", fixture.workspace], fixture.deviceEnv)).records.length, 1, "nothing is released before the confirmation");
    confirming.querySelector("[data-gate-release-confirm]").click();
    const record = await waitFor(() => document.querySelector(`#migrated-gates-list [data-released-gate="${gateId}"] [data-gate-release-record]`), "the released gate");
    assert.match(record.textContent, /agent:test-portal/u);
    assert.match(record.textContent, /The Owner accepted the Story by hand\./u);
    assert.ok(document.querySelector("#migrated-gates-list [data-migrated-gates-empty]"), "no migrated gate holds work back any more");
    assert.deepEqual((await cli(["work-gate-list", "--workspace", fixture.workspace], fixture.deviceEnv)).records, []);
  } finally { await closePage(page, fixture); }
});
