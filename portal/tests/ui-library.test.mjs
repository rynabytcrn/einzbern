// SPDX-License-Identifier: Apache-2.0
// Tests in this file run sequentially; Node isolates each file in a process.
import { COMPLETE_ID, GHOST_TARGET, MUTATION, assert, cli, closePage, expectedTargetLabels, fixtureProjectIds, join, keydown, loadExecutedDom, localeTable, nextAt, openWorkEditor, preparePage, projectChainFixture, receiptText, rm, scratch, test, waitFor, writeScratch } from "./ui-presence-support.mjs";




if (!MUTATION) test("R43 navigation destinations are anchors and full identity stays in keyboard Details", async () => {
  const page = await preparePage();
  try {
    const nav = [...page.document.querySelectorAll("#primary-side-nav [data-page-target]")];
    assert.ok(nav.length > 0);
    assert.ok(nav.every(node => node.tagName === "A" && node.getAttribute("href") === "#" + node.dataset.pageTarget));
    const details = page.document.querySelector("#library-details");
    assert.ok(details.querySelector("summary"));
    assert.ok(details.textContent.includes(page.workspace));
    assert.ok(details.querySelector("#engine-connection"));
    assert.equal(page.document.querySelector("header #engine-connection"), null);
  } finally { await page.cleanup(); }
});



if (!MUTATION) test("R45 U14: targets are named, not identified, in the filter, the selection and the common default; their identities are in keyboard Details with a copy action", async () => {
  const fixture = await projectChainFixture("tcrn-r45-u14-dom-");
  const [ownTarget, secondTarget, thirdTarget] = fixture.targets;
  await cli(["work-create", "--workspace", fixture.workspace, "--project-id", fixture.projectId, "--at", nextAt(), "--external-key", "R45-U14-WORK", "--kind", "Initiative", "--title", "Targets of record", "--involved-projects", JSON.stringify({ state: "selected", targets: [secondTarget, GHOST_TARGET] })], fixture.atelier);
  const locales = await localeTable();
  // TCRN-CROSS-INIT-053 R46 (I01, I09; PC-2): each target carries its project's name from project-list,
  // so the expectation is derived from the API's names by the label rule, and the names are the real ones.
  const projectName = async (library, projectId) => (await cli(["project-list", "--workspace", library], fixture.deviceEnv)).records.find((record) => record.id === projectId)?.name ?? null;
  const own = { ...ownTarget, name: await projectName(fixture.workspace, fixture.projectId) };
  const second = { ...secondTarget, name: await projectName(fixture.second.library, fixture.second.projectId) };
  const third = { ...thirdTarget, name: await projectName(fixture.third.library, fixture.third.projectId) };
  assert.deepEqual([own.name, second.name, third.name], ["TCRN-INC148-DOM", "TCRN-INC148-DOM-SECOND", "TCRN-R45-THIRD"]);
  const labelsIn = (locale, targets) => expectedTargetLabels(targets, (target) => target.unavailable ? locales[locale]["projects.unavailable"] : target.name ?? locales[locale]["projects.unnamed"]);
  const page = await loadExecutedDom(fixture);
  try {
    const { document } = page;
    const editor = await openWorkEditor(page);
    const available = [own, second, third];
    const filterTexts = () => [...editor.querySelectorAll("[data-target-filter] option")].slice(1).map((option) => option.textContent);
    assert.deepEqual(filterTexts(), labelsIn("en", available), "the filter names the targets by the label rule");
    assert.deepEqual(filterTexts(), ["TCRN-INC148-DOM", "TCRN-INC148-DOM-SECOND", "TCRN-R45-THIRD"], "a named project reads as its name, not as Unnamed project");
    const candidates = [{ ...GHOST_TARGET, unavailable: true }, ...available];
    const expectedCandidates = [locales.en["projects.unavailable"], ...labelsIn("en", available)];
    // The published bridge raises the listbox to the page body while it is mounted; the native value
    // select stays in the editor.
    assert.deepEqual([...editor.querySelectorAll(".tcrn-multi-select-dropdown__value option")].map((option) => option.textContent), expectedCandidates, "the selection names its candidates alike, an unavailable reference first");
    assert.deepEqual([...document.querySelectorAll("#work-project-options [data-multi-select-label]")].map((label) => label.textContent), expectedCandidates);
    for (const node of [...editor.querySelectorAll("option"), ...document.querySelectorAll("#work-project-options [role=option]")]) {
      assert.doesNotMatch(node.textContent, COMPLETE_ID, "no visible label holds a complete id");
      assert.equal(node.hasAttribute("title"), false, "identity is not hidden in a title");
      assert.doesNotMatch(node.getAttribute("aria-label") ?? "", COMPLETE_ID, "the accessible name is the label, not the identity");
    }
    assert.deepEqual(new Set([...editor.querySelectorAll(".tcrn-multi-select-dropdown__value option[selected]")].map((option) => JSON.parse(option.value).projectId)), new Set([second.projectId, GHOST_TARGET.projectId]), "the saved relation stays selected, the unavailable reference included");

    const details = editor.querySelector('[data-identity-details="work-targets"]');
    assert.equal(details?.tagName, "DETAILS");
    assert.ok(details.classList.contains("tcrn-disclosure-panel"));
    const summary = details.querySelector(":scope > summary");
    assert.ok(summary.classList.contains("tcrn-disclosure-panel__title"));
    assert.equal(summary.textContent, locales.en["projects.identity"]);
    const rows = [...details.querySelectorAll("[data-identity-row]")];
    assert.deepEqual(rows.map((row) => row.querySelector("[data-identity-value]").textContent), candidates.map((target) => `${target.libraryId} / ${target.projectId}`), "every candidate's complete identity is in the Details");
    assert.deepEqual(rows.map((row) => row.querySelector("dt").textContent), expectedCandidates, "each identity is labelled as the lists label it");

    // Keyboard: the summary is the native disclosure toggle. Escape inside closes it and gives focus back.
    details.setAttribute("open", "");
    let summaryFocused = 0;
    summary.focus = () => { summaryFocused += 1; };
    const copy = rows[1].querySelector("[data-copy-identity]");
    keydown(page, copy, "Escape");
    assert.equal(details.hasAttribute("open"), false, "Escape closes the Details");
    assert.equal(summaryFocused, 1, "focus returns to the summary");

    // Copy: linkedom's window answers navigator with a fixed object that has no clipboard, so here the
    // action takes the Clipboard family's "unavailable" branch: it says so in its own status region,
    // keeps focus, and returns to its idle label. The value it carries is the row's complete identity;
    // the written value and the copied state are taken in a real browser (r45-portal-raw/browser).
    assert.equal(copy.getAttribute("data-copy-identity"), rows[1].querySelector("[data-identity-value]").textContent, "the action carries the row's complete identity");
    assert.equal(copy.getAttribute("data-clipboard-copy-state"), "idle");
    assert.equal((copy.querySelector("[data-copy-label]")?.textContent ?? [...copy.childNodes].find((node) => node.nodeType === 3)?.textContent), locales.en["copy.idle"]);
    assert.equal(copy.querySelector("[data-copy-status]").getAttribute("role"), "status");
    assert.equal(copy.querySelector("[data-copy-status]").getAttribute("aria-live"), "polite");
    assert.equal(copy.getAttribute("aria-label"), locales.en["projects.copyIdentity"].replace("{name}", expectedCandidates[1]));
    assert.doesNotMatch(copy.getAttribute("aria-label"), COMPLETE_ID, "the copy action is named without the value it copies");
    let copyFocused = 0;
    copy.focus = () => { copyFocused += 1; };
    copy.click();
    await waitFor(() => copy.getAttribute("data-clipboard-copy-state") === "unsupported", "the copy action's answer");
    assert.equal(copy.querySelector("[data-copy-status]").textContent, locales.en["copy.unsupported"]);
    assert.equal((copy.querySelector("[data-copy-label]")?.textContent ?? [...copy.childNodes].find((node) => node.nodeType === 3)?.textContent), locales.en["copy.unsupported"]);
    assert.equal(copyFocused, 0, "the published unsupported branch leaves native focus unchanged");
    await waitFor(() => copy.getAttribute("data-clipboard-copy-state") === "idle", "the copy action to return to idle", 5000);
    assert.equal(copy.querySelector("[data-copy-status]").textContent, "");
    assert.equal((copy.querySelector("[data-copy-label]")?.textContent ?? [...copy.childNodes].find((node) => node.nodeType === 3)?.textContent), locales.en["copy.idle"]);

    // The common default lists the other targets by the same rule. (A saved common default that no
    // registered library answers makes the engine refuse this target's whole effective configuration,
    // so the settings page has no catalog to draw it from; recorded as a problem, not drawn here.)
    document.querySelector('[data-page-target="settings"]')?.click();
    const bindings = await waitFor(() => document.querySelector("[data-project-bindings]"), "the project bindings section");
    const common = bindings.querySelector("[data-common-source]");
    const others = [second, third];
    assert.deepEqual([...common.querySelectorAll("option")].slice(1).map((option) => option.textContent), labelsIn("en", others));
    assert.equal(common.querySelector("option[selected]"), null, "no common default is saved");
    for (const option of common.querySelectorAll("option")) assert.doesNotMatch(option.textContent, COMPLETE_ID);
    assert.deepEqual([...bindings.querySelectorAll('[data-identity-details="common-default"] [data-identity-value]')].map((node) => node.textContent), others.map((target) => `${target.libraryId} / ${target.projectId}`));
    assert.deepEqual([...bindings.querySelectorAll("[data-repository-field]")].length, 0, "no repository binding is saved");

    // Five languages: a project's own name stays, while the Details, the unavailable reference and the
    // copy action follow the page's language.
    for (const locale of ["zh-CN", "ja", "ko", "fr", "en"]) {
      document.querySelector(`[data-locale-option="${locale}"]`)?.click();
      await waitFor(() => document.querySelector('#work-target-editor [data-identity-details="work-targets"] summary')?.textContent === locales[locale]["projects.identity"], `${locale}: the editor in the page's language`);
      assert.deepEqual(filterTexts(), labelsIn(locale, available), `${locale}: the filter keeps the projects' names`);
      const localizedDetails = document.querySelector('#work-target-editor [data-identity-details="work-targets"]');
      assert.equal(localizedDetails.querySelector("summary").textContent, locales[locale]["projects.identity"]);
      assert.equal((localizedDetails.querySelector("[data-copy-label]")?.textContent ?? [...localizedDetails.querySelector("[data-copy-identity]").childNodes].find((node) => node.nodeType === 3)?.textContent), locales[locale]["copy.idle"]);
      assert.equal(localizedDetails.querySelector("dt").textContent, locales[locale]["projects.unavailable"]);
    }
  } finally { await closePage(page, fixture); }
});



// TCRN-CROSS-INIT-053 R46 (I10; U20 D3, receipt badge): a library switch clears what the page showed for the
// library it leaves -- the design authority panel, the receipt and the readiness result -- before the next
// library is read, so nothing of the old one is on screen while the new one loads.
if (!MUTATION) test("R46 I10: a library switch clears the design authority panel, the receipt and the readiness result before the next library is read", async () => {
  const fixture = await scratch("tcrn-r46-i10-leave-");
  // A declared but incomplete authority produces a real warning to clear; absence is intentionally silent.
  await writeScratch(fixture, "settings-set", ["--key", "design.authority", "--value", "https://design.example.test/partial"]);
  await cli(["work-create", "--workspace", fixture.workspace, "--project-id", fixture.projectId, "--at", nextAt(), "--external-key", "R46-I10-LEAVE", "--kind", "Initiative", "--title", "Work of the first library"], fixture.deviceEnv);
  const locales = await localeTable();
  const page = await loadExecutedDom(fixture);
  try {
    const { document, window } = page;
    const editor = await openWorkEditor(page);
    editor.querySelector("[data-target-context]").click();
    await waitFor(() => editor.querySelector("[data-target-result]")?.innerHTML !== "", "the readiness result");
    document.querySelector('[data-page-target="settings"]')?.click();
    document.querySelector('[data-setting-group="atelier"]')?.click();
    const control = document.querySelector('[data-machine-control="portal.defaultTheme"]');
    control.value = control.value === "dark" ? "light" : "dark";
    control.dispatchEvent(new window.Event("change", { bubbles: true }));
    await waitFor(() => document.querySelector("#operation-feedback")?.dataset.operationPhase === "success", "the write's receipt");
    assert.notEqual(receiptText(document), locales.en["chip.idle"]);
    document.querySelector("#receipt-chip").click();
    assert.equal(document.querySelector("#receipt-drawer").dataset.open, "true");
    document.querySelector('[data-setting-group="general"]')?.click();
    const panel = document.querySelector("#design-authority");
    await waitFor(() => panel.hidden === false && panel.querySelector("[data-design-authority-state]"), "the first library's design authority panel");
    assert.equal(panel.querySelector("[data-design-authority-state]").dataset.designAuthorityState, "unconfigured", "an explicit partial authority retains its warning");
    await page.waitForSettled();
    page.hold((path) => path === "/api/settings");
    const select = document.querySelector("#library-select");
    select.value = fixture.second.project;
    select.dispatchEvent(new window.Event("change", { bubbles: true }));
    await waitFor(() => page.held() === 1, "the second library's settings read");
    assert.equal(panel.hidden, true, "the panel is hidden before the next library is read");
    assert.equal(panel.innerHTML, "", "and holds nothing of the library left");
    assert.equal(receiptText(document), locales.en["chip.idle"], "the receipt badge is idle again");
    assert.equal(document.querySelector("#receipt-chip").className, "tcrn-badge tcrn-badge--positive");
    assert.equal(document.querySelector("#receipt-drawer").dataset.open, "false", "the drawer closed");
    assert.equal(document.querySelector("#operation-feedback").dataset.operationPhase, "idle");
    assert.equal(editor.querySelector("[data-target-result]")?.innerHTML ?? "", "", "the readiness result is gone");
    assert.equal(page.release(), 1);
    await page.waitForSettled();
    await waitFor(() => document.querySelector("#rail-workspace-label").textContent === "TCRN-INC148-DOM-SECOND", "the second library");
    assert.equal(receiptText(document), locales.en["chip.idle"], "a switch leaves no receipt of the library left");
  } finally { await closePage(page, fixture); }
});



// TCRN-CROSS-INIT-053 R46 (I10; U20 D13, PC-3): two tabs of one Atelier. When the other tab switches the
// library, this tab's next read is refused with the selection as it is now: the page names both libraries
// above its pages, shows none of the other library's values under its own name, refuses a write, and
// switches back on request. A switch refused elsewhere only moves the epoch: the page reads again without
// a notice.
if (!MUTATION) test("R46 I10: another tab's switch is named on this page, which shows none of the other library's values and switches back", async () => {
  const fixture = await scratch("tcrn-r46-i10-tabs-");
  await cli(["settings-set", "--workspace", fixture.second.library, "--at", nextAt(), "--actor", "agent:test", "--key", "artifact.language", "--value", "zh-CN"], { ...fixture.deviceEnv, EINZBERN_SURFACE: "atelier" });
  const locales = await localeTable();
  const tabA = await loadExecutedDom(fixture);
  const tabB = await loadExecutedDom(fixture, {}, { portal: { child: tabA.child, url: tabA.url } });
  const languageRow = () => tabA.document.querySelector('[data-setting-row="artifact.language"] [data-setting-control]')?.value;
  const readAgain = (tab, status) => {
    const filter = tab.document.querySelector('[data-ui="knowledge-status-filter"]');
    filter.value = status;
    filter.dispatchEvent(new tab.window.Event("change", { bubbles: true }));
  };
  try {
    tabA.document.querySelector('[data-page-target="settings"]')?.click();
    tabA.document.querySelector('[data-setting-group="knowledge"]')?.click();
    const firstLanguage = languageRow();
    assert.equal(typeof firstLanguage, "string", "tab A shows the first library's artifact language");
    assert.notEqual(firstLanguage, "zh-CN");
    // Tab B moves the selection to the second library.
    const selectB = tabB.document.querySelector("#library-select");
    selectB.value = fixture.second.project;
    selectB.dispatchEvent(new tabB.window.Event("change", { bubbles: true }));
    await waitFor(() => tabB.document.querySelector("#rail-workspace-label").textContent === "TCRN-INC148-DOM-SECOND", "tab B on the second library");
    await tabB.waitForSettled();
    // Tab A reads: refused, named, and nothing of the second library shown.
    readAgain(tabA, "all");
    const notice = await waitFor(() => tabA.document.querySelector('#target-notice:not([hidden]) [data-target-notice]'), "the notice on tab A");
    assert.equal(notice.querySelector("span").textContent, locales.en["target.changedElsewhere"].replace("{current}", "TCRN-INC148-DOM-SECOND").replace("{previous}", "TCRN-INC148-DOM"));
    assert.equal(notice.querySelector("[data-target-follow]").textContent, locales.en["target.follow"].replace("{name}", "TCRN-INC148-DOM-SECOND"));
    assert.ok(notice.classList.contains("tcrn-inline-alert") && notice.classList.contains("tcrn-inline-alert--warning"));
    await tabA.waitForSettled();
    assert.equal(tabA.document.querySelector("#rail-workspace-label").textContent, "TCRN-INC148-DOM");
    assert.equal(languageRow(), firstLanguage, "tab A shows none of the second library's values");
    // A write from tab A is refused, and neither library changes.
    const before = { first: (await cli(["settings-catalog", "--workspace", fixture.workspace], fixture.deviceEnv)).settings.find((entry) => entry.key === "artifact.language").currentValue, second: (await cli(["settings-catalog", "--workspace", fixture.second.library], fixture.deviceEnv)).settings.find((entry) => entry.key === "artifact.language").currentValue };
    const control = tabA.document.querySelector('[data-setting-row="artifact.language"] [data-setting-control]');
    control.value = "fr";
    control.dispatchEvent(new tabA.window.Event("change", { bubbles: true }));
    await waitFor(() => /^✕/u.test(receiptText(tabA.document)), "the refused write's receipt");
    assert.match(tabA.document.querySelector("#receipt-raw").textContent, /PORTAL_CONFIGURATION_TARGET_CHANGED/u);
    await tabA.waitForSettled();
    assert.deepEqual({ first: (await cli(["settings-catalog", "--workspace", fixture.workspace], fixture.deviceEnv)).settings.find((entry) => entry.key === "artifact.language").currentValue, second: (await cli(["settings-catalog", "--workspace", fixture.second.library], fixture.deviceEnv)).settings.find((entry) => entry.key === "artifact.language").currentValue }, before);
    // Switch back: the selection is the first library again and the notice is gone.
    tabA.document.querySelector("[data-target-switch-back]").click();
    await waitFor(() => tabA.document.querySelector("#target-notice").hidden === true, "the notice to leave");
    await tabA.waitForSettled();
    const boot = JSON.parse(tabA.source.match(/const BOOT = (\{[^\n]*\});/u)[1]);
    const selected = await (await tabA.serverRequest("/api/libraries", { headers: { "x-portal-token": boot.token } })).json();
    assert.equal(selected.selected.projectPath, fixture.proseRoot, "the selection is the first library again");
    assert.equal(tabA.document.querySelector("#rail-workspace-label").textContent, "TCRN-INC148-DOM");
    // Tab B, still showing the second library, is told in turn.
    readAgain(tabB, "removed");
    await waitFor(() => tabB.document.querySelector('#target-notice:not([hidden]) [data-target-notice]'), "the notice on tab B");
    // A switch refused elsewhere moves only the epoch: tab A reads again, with no notice.
    const refused = await tabA.serverRequest("/api/library", { method: "POST", headers: { "content-type": "application/json", "x-portal-token": boot.token }, body: JSON.stringify({ library: "not-a-registered-library" }) });
    assert.equal(refused.status, 404);
    readAgain(tabA, "removed");
    await waitFor(() => tabA.document.querySelector('[data-ui="knowledge-status-filter"]')?.value === "removed", "tab A's read after the refused switch");
    await tabA.waitForSettled();
    assert.equal(tabA.document.querySelector("#target-notice").hidden, true, "a refused switch is not another tab's selection");
  } finally {
    try { await tabB.waitForSettled(); } catch { /* the case's own assertion already failed */ }
    await closePage(tabA, fixture);
  }
});



// TCRN-CROSS-INIT-053 R46 (I10): an answer that comes back after the page has left its library is dropped,
// not rendered into the next one.
if (!MUTATION) test("R46 I10: an answer for the library the page has left is dropped", async () => {
  const fixture = await scratch("tcrn-r46-i10-late-");
  await cli(["knowledge-init", "--workspace", fixture.second.library, "--acknowledge-disposable", "true"], fixture.deviceEnv);
  const page = await loadExecutedDom(fixture);
  try {
    const { document, window } = page;
    document.querySelector('[data-page-target="dashboard"]')?.click();
    document.querySelector('[data-workspace-tab="knowledge"]')?.click();
    assert.ok(document.querySelector('#knowledge-view-content [data-knowledge-store="absent"]'), "the first library has no knowledge store");
    let reads = 0;
    page.hold((path) => path === "/api/knowledge?status=all" && (reads += 1) === 1);
    const filter = document.querySelector('[data-ui="knowledge-status-filter"]');
    filter.value = "all";
    filter.dispatchEvent(new window.Event("change", { bubbles: true }));
    await waitFor(() => page.held() === 1, "the first library's knowledge read");
    const select = document.querySelector("#library-select");
    select.value = fixture.second.project;
    select.dispatchEvent(new window.Event("change", { bubbles: true }));
    await waitFor(() => document.querySelector("#rail-workspace-label").textContent === "TCRN-INC148-DOM-SECOND", "the second library");
    await page.waitForSettled();
    assert.equal(document.querySelector('#knowledge-view-content [data-knowledge-store="absent"]'), null, "the second library has a store");
    assert.equal(page.release(), 1);
    await page.waitForSettled();
    assert.equal(document.querySelector('#knowledge-view-content [data-knowledge-store="absent"]'), null, "the first library's late answer is not shown");
    assert.equal(document.querySelector("#target-notice").hidden, true);
  } finally { await closePage(page, fixture); }
});



if (!MUTATION) test("R45 U14: execution contexts read as one row per target in the page's language, not as JSON", async () => {
  const fixture = await projectChainFixture("tcrn-r45-u14-context-");
  const [, second] = fixture.targets;
  await cli(["work-create", "--workspace", fixture.workspace, "--project-id", fixture.projectId, "--at", nextAt(), "--external-key", "R45-U14-CONTEXT", "--kind", "Initiative", "--title", "Contexts of record", "--involved-projects", JSON.stringify({ state: "selected", targets: [second, GHOST_TARGET] })], fixture.atelier);
  const locales = await localeTable();
  const page = await loadExecutedDom(fixture);
  try {
    const editor = await openWorkEditor(page);
    const context = await cli(["work-project-context", "--workspace", fixture.workspace, "--id", (await cli(["work-list", "--workspace", fixture.workspace], fixture.deviceEnv)).records.find((record) => record.externalKey === "R45-U14-CONTEXT").id], fixture.deviceEnv);
    editor.querySelector("[data-target-context]").click();
    const view = await waitFor(() => editor.querySelector("[data-project-context]"), "the execution contexts");
    assert.equal(view.querySelectorAll("pre").length, 0, "no raw JSON block");
    assert.doesNotMatch(view.querySelector("dl").textContent, /[{}]/u, "the rows are read, not serialized");
    const rows = [...view.querySelectorAll("[data-context-target]")];
    assert.deepEqual(rows.map((row) => JSON.parse(row.dataset.contextTarget).projectId), context.contexts.map((entry) => entry.reference.projectId), "one row per target, in the engine's order");
    for (const [index, entry] of context.contexts.entries()) {
      const row = rows[index];
      const statusKey = { configured: "projects.statusConfigured", unconfigured: "projects.statusUnconfigured", unregistered: "projects.statusUnregistered", unavailable: "projects.statusUnavailable", "invalid-chain": "projects.statusInvalidChain", "project-absent": "projects.statusProjectAbsent", "project-deleted": "projects.statusProjectDeleted", ambiguous: "projects.statusAmbiguous", conflicting: "projects.statusConflicting" }[entry.status];
      assert.ok(statusKey, `the engine status ${entry.status} has a label`);
      assert.equal(row.querySelector("[data-context-status-label]").textContent, locales.en[statusKey]);
      assert.doesNotMatch(row.querySelector("dt").textContent, COMPLETE_ID, "a row is named by its label");
      const missing = entry.readiness?.development?.missing ?? [];
      assert.deepEqual([...row.querySelectorAll("[data-context-missing] code")].map((node) => node.textContent), missing, "what development still misses is listed by its engine name");
    }
    assert.equal(rows.find((row) => JSON.parse(row.dataset.contextTarget).projectId === GHOST_TARGET.projectId)?.querySelector("dt").textContent, locales.en["projects.unavailable"]);
    assert.deepEqual([...view.querySelectorAll('[data-identity-details="work-contexts"] [data-identity-value]')].map((node) => node.textContent), context.contexts.map((entry) => `${entry.reference.libraryId} / ${entry.reference.projectId}`), "the complete identities are in the Details");
    assert.equal(view.querySelector('[data-context-readiness="development"] .tcrn-badge').textContent, context.developmentReady ? locales.en["projects.ready"] : locales.en["projects.notReady"]);
    const summary = view.querySelector(":scope > summary");
    let focused = 0;
    summary.focus = () => { focused += 1; };
    keydown(page, view.querySelector("dl"), "Escape");
    assert.equal(view.hasAttribute("open"), false, "Escape closes the contexts");
    assert.equal(focused, 1, "and returns focus to their summary");
  } finally { await closePage(page, fixture); }
});



// TCRN-CROSS-INIT-053 R45 (U15): the desktop rail has the published SideNavCollapseButton beside the
// brand, as ProductShell renders it. It narrows the rail to the family's icon rail through the shell's
// own attribute, names the action it will take in the page's language, and leaves the stacked mobile
// shell to the mobile toggle (the family's CSS hides it there; the width itself is measured in a real
// browser, r45-portal-raw/browser).
if (!MUTATION) test("R45 U15: the side navigation collapses and expands through the published collapse control, named in the page's language", async () => {
  const page = await preparePage();
  try {
    const { document } = page;
    const locales = await localeTable();
    const shell = document.querySelector(".tcrn-product-shell");
    const toggle = document.querySelector(".tcrn-product-shell__sidebar-header > #side-nav-toggle");
    assert.ok(toggle, "the collapse control sits in the sidebar header");
    assert.deepEqual(["tcrn-button", "tcrn-icon-button", "tcrn-shell-side-nav-toggle"].filter((name) => toggle.classList.contains(name)), ["tcrn-button", "tcrn-icon-button", "tcrn-shell-side-nav-toggle"], "it is the published IconButton construction");
    assert.equal(toggle.getAttribute("type"), "button");
    assert.equal(toggle.getAttribute("aria-controls"), "primary-side-nav");
    assert.equal(toggle.dataset.shellControl, "side-nav-collapse");
    assert.equal([...toggle.querySelectorAll("[data-side-nav-icon] svg")].length, 2, "both icons are inline SVG");
    const children = [...document.querySelector(".tcrn-product-shell__sidebar-header").children].map((node) => node.id);
    assert.deepEqual(children, ["brand-button", "side-nav-toggle", "mobile-nav-toggle"], "brand, collapse control, mobile toggle, in the family's order");
    const brand = document.querySelector("#brand-button");
    assert.equal(brand.tagName, "A", "the brand is the published home link");
    assert.equal(brand.getAttribute("href"), "#dashboard");
    assert.equal(shell.getAttribute("data-product-shell-collapsed"), "false");
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    assert.equal(toggle.getAttribute("aria-label"), locales.en["shell.collapseNavigation"]);
    toggle.click();
    assert.equal(shell.getAttribute("data-product-shell-collapsed"), "true", "the shell carries the collapsed state the family's CSS reads");
    assert.equal(shell.getAttribute("data-side-nav-collapsed"), "true");
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    assert.equal(toggle.getAttribute("aria-label"), locales.en["shell.expandNavigation"]);
    assert.equal(toggle.getAttribute("title"), locales.en["shell.expandNavigation"]);
    for (const locale of ["zh-CN", "ja", "ko", "fr"]) {
      document.querySelector(`[data-locale-option="${locale}"]`)?.click();
      assert.equal(toggle.getAttribute("aria-label"), locales[locale]["shell.expandNavigation"], `${locale}: the action is named in the page's language`);
    }
    toggle.click();
    assert.equal(shell.getAttribute("data-product-shell-collapsed"), "false");
    assert.equal(toggle.getAttribute("aria-label"), locales.fr["shell.collapseNavigation"]);
    const css = page.source;
    assert.match(css, /\.tcrn-product-shell\[data-product-shell-collapsed="true"\] \.tcrn-rail__mark,\s*\.tcrn-product-shell\[data-product-shell-collapsed="true"\] \.tcrn-rail__footer \{\s*display: none;/u, "the rail's library name and footer leave the icon rail");
  } finally { await page.cleanup(); }
});

if (!MUTATION) {

  // TCRN-CROSS-STORY-482 R3, AC1: the top bar's switcher lists the registry's two libraries, each
  // by its project path and library id; choosing the other one moves the whole page to it (its path,
  // its name and id in the rail, its status, its Rules file), and choosing back returns. The second
  // library carries one event of its own, so its status differs from the first's.
  test("STORY-482 AC1: the page switches between the registry's two libraries and shows each one's status", async () => {
    const fixture = await scratch("tcrn-482-ac1-dom-");
    await cli(["settings-set", "--workspace", fixture.second.library, "--at", nextAt(), "--actor", "agent:test", "--key", "artifact.language", "--value", "zh-CN"], { ...fixture.deviceEnv, EINZBERN_SURFACE: "atelier" });
    const page = await loadExecutedDom(fixture);
    try {
      const text = (selector) => page.document.querySelector(selector)?.textContent ?? "";
      const select = page.document.querySelector('[data-ui="library-switcher"]');
      assert.equal(select?.id, "library-select");
      const options = [...select.querySelectorAll("option")];
      assert.deepEqual(options.map((option) => option.getAttribute("value")), [fixture.proseRoot, fixture.second.project]);
      // INIT-053 R46 (I01, I09): project-list names each project, and the page names a library by its
      // project's own name end to end: the switcher, the rail and the top bar show the fixture's real
      // names ("Unnamed project" is only for a project that has none).
      const named = async (library) => ({
        name: (await cli(["project-list", "--workspace", library], fixture.deviceEnv)).records.find(record => record.id === fixtureProjectIds.get(library)).name ?? null,
        libraryId: (await cli(["status", "--workspace", library], fixture.deviceEnv)).workspaceId,
        projectId: fixtureProjectIds.get(library),
      });
      const listed = [await named(fixture.workspace), await named(fixture.second.library)];
      assert.deepEqual(listed.map((entry) => entry.name), ["TCRN-INC148-DOM", "TCRN-INC148-DOM-SECOND"], "project-list names both projects");
      const locales = await localeTable();
      const [firstName, secondName] = expectedTargetLabels(listed, (entry) => entry.name ?? locales.en["projects.unnamed"]);
      assert.deepEqual([firstName, secondName], ["TCRN-INC148-DOM", "TCRN-INC148-DOM-SECOND"], "two named projects read as their names, with no id tail");
      assert.deepEqual(options.map(option => option.textContent), [firstName, secondName], "navigation uses canonical names, full identity belongs in Details");
      for (const option of options) assert.doesNotMatch(option.textContent, /(?:library|project):[0-9a-f]{24}/u, "no complete id in the visible label");
      assert.equal(options[0].hasAttribute("selected"), true);
      const firstId = text("#library-label");
      assert.match(firstId, /^library:/u);
      assert.equal(text("#rail-workspace-label"), firstName);
      assert.equal(text("#workspace-label"), firstName);
      assert.equal(text("#stat-version"), "1");
      const healthReasons = () => [...page.document.querySelectorAll("[data-doctor-check]")].map((row) => [row.dataset.doctorCheck, row.querySelectorAll(".tcrn-operation-feedback__identity code")[1]?.textContent ?? ""]);
      const initialDoctor = await cli(["doctor", "--project", fixture.proseRoot], { ...fixture.deviceEnv, HOME: fixture.home });
      assert.deepEqual(healthReasons(), initialDoctor.checks.map((check) => [check.check, check.reasonCode ?? "—"]));

      const secondVersion = String((await cli(["status", "--workspace", fixture.second.library], fixture.deviceEnv)).version);
      select.value = fixture.second.project;
      select.dispatchEvent(new page.window.Event("change", { bubbles: true }));
      await waitFor(() => text("#workspace-label") === secondName && text("#stat-version") === secondVersion && text("#agents-path") === join(fixture.second.project, "AGENTS.md"), "the page to move to the second library");
      assert.equal(text("#rail-workspace-label"), secondName);
      assert.notEqual(text("#library-label"), firstId);
      assert.ok(text("#library-label").includes(fixture.second.library), "Details retains the full selected path");
      const secondDoctor = await cli(["doctor", "--project", fixture.second.project], { ...fixture.deviceEnv, HOME: fixture.home });
      assert.equal(page.document.querySelector("#health-chip")?.className.includes("tcrn-badge--positive"), secondDoctor.ok);
      assert.deepEqual(healthReasons(), secondDoctor.checks.map((check) => [check.check, check.reasonCode ?? "—"]));
      assert.equal(text('#library-state [data-library-field="versionVector"]'), JSON.stringify((await cli(["status", "--workspace", fixture.second.library], fixture.deviceEnv)).versionVector));
      assert.equal(page.requests.filter((path) => path === "/api/library").length, 1);

      const stateLabels = {
        en: ["Saved event count by device", "Device histories", "Rejected events", "Effective configuration"],
        "zh-CN": ["各设备已保存事件数", "设备历史", "被拒事件数", "当前有效配置"],
        ja: ["デバイス別の保存イベント数", "デバイスの履歴", "拒否されたイベント数", "適用中の設定"],
        ko: ["기기별 저장 이벤트 수", "기기 기록", "거부된 이벤트 수", "적용 중인 설정"],
        fr: ["Événements enregistrés par appareil", "Historiques des appareils", "Événements rejetés", "Configuration effective"],
      };
      const stateKeys = ["dashboard.versionVector", "dashboard.streams", "dashboard.rejectedEvents", "dashboard.configProjection"];
      for (const [locale, labels] of Object.entries(stateLabels)) {
        page.document.querySelector(`[data-locale-option="${locale}"]`)?.click();
        await waitFor(() => page.document.documentElement.lang === locale, `the ${locale} locale`);
        assert.deepEqual(stateKeys.map((key) => page.document.querySelector(`#library-state [data-i18n="${key}"]`)?.textContent), labels);
        // The switcher, the rail and the top bar keep a project's own name in every language (only an
        // unnamed one would follow the language).
        const localized = expectedTargetLabels(listed, (entry) => entry.name ?? locales[locale]["projects.unnamed"]);
        assert.deepEqual([...select.querySelectorAll("option")].map((option) => option.textContent), localized, `${locale}: the switcher follows the language`);
        assert.equal(text("#rail-workspace-label"), localized[1], `${locale}: the rail follows the language`);
      }

      const firstVersion = String((await cli(["status", "--workspace", fixture.workspace], fixture.deviceEnv)).version);
      const [firstNameInFrench] = expectedTargetLabels(listed, (entry) => entry.name ?? locales.fr["projects.unnamed"]);
      page.document.querySelector("#library-select").value = fixture.proseRoot;
      page.document.querySelector("#library-select").dispatchEvent(new page.window.Event("change", { bubbles: true }));
      await waitFor(() => text("#workspace-label") === firstNameInFrench && text("#stat-version") === firstVersion && text("#agents-path") === join(fixture.proseRoot, "AGENTS.md"), "the page to return to the first library");
      assert.equal(text("#library-label"), firstId);
      const firstDoctor = await cli(["doctor", "--project", fixture.proseRoot], { ...fixture.deviceEnv, HOME: fixture.home });
      assert.equal(page.document.querySelector("#health-chip")?.className.includes("tcrn-badge--positive"), firstDoctor.ok);
      assert.deepEqual(healthReasons(), firstDoctor.checks.map((check) => [check.check, check.reasonCode ?? "—"]));
    } finally { await closePage(page, fixture); }
  });
}
