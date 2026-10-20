// SPDX-License-Identifier: Apache-2.0
// Tests in this file run sequentially; Node isolates each file in a process.
import { COMPLETE_ID, GHOST_TARGET, MUTATION, assert, cli, closePage, coordinationContainerFixture, join, keydown, loadExecutedDom, localeTable, mkdir, nextAt, policySwitchControls, portalRoot, preparePage, projectChainFixture, readFile, receiptAdvanced, receiptText, scratch, test, waitFor, writeFile } from './ui-presence-support.mjs';
if (!MUTATION) {

  test("TCRN-CROSS-SUB-342 variables page creates, updates, renames, and deletes with an AGENTS.md readback", async () => {
    const page = await preparePage();
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

      let row = page.document.querySelector('[data-variable-row="deploy.host"]');
      field(row, "value").value = "stage.example.com";
      field(row, "description").value = "Staging endpoint";
      before = receiptText(page.document);
      row.querySelector("[data-variable-save]").click();
      await waitFor(() => receiptAdvanced(page.document, before)(), "the variable update receipt");
      await waitFor(() => page.document.querySelector('[data-variable-row="deploy.host"] [data-variable-field="value"]')?.value === "stage.example.com", "the variable update readback");

      row = page.document.querySelector('[data-variable-row="deploy.host"]');
      field(row, "name").value = "deploy.target";
      before = receiptText(page.document);
      row.querySelector("[data-variable-save]").click();
      await waitFor(() => receiptAdvanced(page.document, before)(), "the variable rename receipt");
      await waitFor(() => Boolean(page.document.querySelector('[data-variable-row="deploy.target"]')), "the variable rename readback");
      assert.equal(page.document.querySelector('[data-variable-row="deploy.host"]'), null);
      assert.match(await readFile(join(page.fixture.proseRoot, "AGENTS.md"), "utf8"), /deploy\.target/u);

      before = receiptText(page.document);
      page.document.querySelector('[data-variable-row="deploy.target"] [data-variable-delete]').click();
      await waitFor(() => receiptAdvanced(page.document, before)(), "the variable delete receipt");
      await waitFor(() => page.document.querySelector('[data-variable-row="deploy.target"]') === null, "the variable delete readback");
      const listed = await cli(["variable-list", "--workspace", page.workspace], page.deviceEnv);
      assert.deepEqual(listed.variables, []);
      assert.doesNotMatch(await readFile(join(page.fixture.proseRoot, "AGENTS.md"), "utf8"), /deploy\.target/u, "deleting a variable removes its managed row");
    } finally { await page.cleanup(); }
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
if (!MUTATION) test("540 SUB-508: a coordination library's Rules page names and shows the container's AGENTS.md, and a project's carries no such note", async () => {
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
    await waitFor(() => document.querySelector("#agents-path")?.textContent === join(fixture.proseRoot, "AGENTS.md"), "the page to switch to the project library");
    assert.equal(document.querySelector('[data-ui="prose-binding-note"]').hidden, true, "a project library's Rules page carries no coordination note");
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

    for (const locale of ["en", "zh-CN", "ja", "ko", "fr"]) {
      document.querySelector(`[data-locale-option="${locale}"]`).click();
      await waitFor(() => document.documentElement.lang === locale, `${locale} policy labels`);
      assert.ok(view().querySelector("[data-engine-model-policy-host]")?.getAttribute("aria-label"), `${locale} host selector has an accessible name`);
      assert.ok(field("categories", 0, "id")?.getAttribute("aria-label"), `${locale} category id has an accessible name`);
      assert.ok(field("tiers", 0, "model")?.getAttribute("aria-label"), `${locale} model has an accessible name`);
      assert.equal(escalation("enabled")?.getAttribute("role"), "switch", `${locale} escalation uses the existing switch semantics`);
      assert.ok(view().textContent.trim() && !view().textContent.includes("modelPolicy."), `${locale} translates the engine policy surface`);
    }
    document.querySelector('[data-locale-option="en"]').click();
    type(field("tiers", 0, "note"), "kept through locale and refresh");
    document.querySelector('[data-locale-option="fr"]').click();
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
