// SPDX-License-Identifier: Apache-2.0
// Tests in this file run sequentially; Node isolates each file in a process.
import { CLI, DS_CONTRACT, MUTATION, appendHistoricalGateCreate, asFixtureDevice, assert, cli, closePage, expectedTargetLabels, fixtureProjectIds, join, keydown, loadExecutedDom, localeTable, nextAt, openWorkEditor, pageHierarchyFindings, portalRoot, preparePage, projectChainFixture, readFile, receiptAdvanced, receiptText, rm, scopedWorkFixture, scratch, test, topbarFindings, waitFor, writeFile } from './ui-presence-support.mjs';
if (!MUTATION) {

  test("STORY-482 rendered status card preserves a red doctor reason code", async () => {
    const fixture = await scratch("tcrn-inc151-health-dom-");
    const wrapper = join(fixture.base, "doctor-red-wrapper.mjs");
    await writeFile(wrapper, `import { spawnSync } from "node:child_process";
const actual = spawnSync(process.execPath, [${JSON.stringify(CLI)}, ...process.argv.slice(2)], { encoding: "utf8" });
if (process.argv[2] === "doctor" && actual.status === 0) {
  const body = JSON.parse(actual.stdout);
  body.checks = body.checks.map((check) => check.check === "hooks-present"
    ? { ...check, ok: false, reasonCode: "PORTAL_TEST_HOOKS_RED", detail: { causes: ["PORTAL_TEST_HOOKS_RED"] } }
    : { ...check, ok: true, reasonCode: null, detail: {} });
  body.ok = false;
  process.stdout.write(JSON.stringify(body));
} else {
  process.stdout.write(actual.stdout || "");
  process.stderr.write(actual.stderr || "");
  process.exitCode = actual.status ?? 1;
}
`, "utf8");
    const page = await loadExecutedDom(fixture, { TCRN_WORKFLOW_CLI: wrapper });
    try {
      assert.match(page.document.querySelector("#health-chip").className, /tcrn-badge--danger/u);
      assert.equal(page.document.querySelector("#stat-health").textContent, "7/8");
      const failedCheck = page.document.querySelector('[data-doctor-check="hooks-present"]');
      assert.match(failedCheck.textContent, /failed/u);
      assert.match(failedCheck.textContent, /PORTAL_TEST_HOOKS_RED/u);
    } finally { page.child.kill(); await rm(fixture.base, { recursive: true, force: true }); }
  });
}
if (!MUTATION) {

  test("STORY-402 retires persona and empty-effort dictionary surfaces while keeping dispatch vocabulary current", async () => {
    const page = await preparePage();
    try {
      page.document.querySelector('[data-page-target="vocabulary"]')?.click();
      await new Promise((resolve) => setTimeout(resolve, 60));
      const categories = [...page.document.querySelectorAll("[data-vocabulary-category]")].map((button) => button.dataset.vocabularyCategory);
      assert.ok(categories.includes("conferenceTypes"));
      assert.ok(categories.includes("executionForms"));
      assert.equal(categories.includes("roles"), false);
      assert.equal(categories.includes("efforts"), false);
      assert.equal(page.document.querySelector('[data-vocabulary-table="roles"]'), null);
      assert.equal(page.document.querySelector('[data-vocabulary-table="efforts"]'), null);
      assert.doesNotMatch(await readFile(join(portalRoot, "index.html"), "utf8"), /data-page="articles"|article-form|vocabulary\.roles|vocabulary\.efforts/iu);
      assert.doesNotMatch(await readFile(join(portalRoot, "locales.js"), "utf8"), /vocabulary\.roles|vocabulary\.efforts|persona/iu);
    } finally { await page.cleanup(); }
  });
}
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

  test("TCRN-CROSS-STORY-405 proves the fixed DS semantics, rejects structural mutations, and preserves coordination status", async () => {
    const page = await preparePage();
    try {
      page.document.querySelector('[data-setting-group="execution"]')?.click();
      await new Promise((resolve) => setTimeout(resolve, 80));
      const layout = page.document.querySelector('[data-settings-layout-component="SettingsLayout"]');
      assert.ok(layout);
      const findings = (root) => {
        const output = [];
        if (root.getAttribute("data-ds-candidate") !== `TCRN-Design-System@${DS_CONTRACT.candidate}`) output.push("ds-candidate");
        if (root.getAttribute("data-ds-contract-status") !== DS_CONTRACT.reconciliation.status) output.push("ds-contract-status");
        if (root.getAttribute("data-ds-contract-version") !== "ai_consumption_contract_v1") output.push("ds-contract-version");
        if (root.getAttribute("data-ds-contract-digest") !== DS_CONTRACT.aiContract.payloadDigest) output.push("ds-contract-digest");
        if (root.getAttribute("data-ds-rules") !== "DS-106-R1 DS-106-R2 DS-107-R1 DS-107-R2 DS-108-R1 DS-108-R2 DS-112-R1 DS-112-R2 DS-116-R1 DS-116-R2 DS-117-R1 DS-117-R2 DS-118-R1 DS-118-R2 DS-119-R1 DS-119-R2") output.push("ds-rules");
        if (root.getAttribute("data-settings-layout-navigation-location") !== "page-hierarchy-section-tabs") output.push("navigation-location");
        const required = {
          "data-settings-layout-mode": "container-driven",
          "data-settings-layout-form-policy": "single-host-single-column",
          "data-settings-layout-breakpoint": "960px",
          "data-settings-content-breakpoint": "720px",
          "data-settings-local-navigation": "compact",
          "data-settings-overflow-policy": "no-page-overflow",
          "data-settings-long-value-policy": "native-inline-scroll-copy",
        };
        for (const [attribute, expected] of Object.entries(required)) if (root.getAttribute(attribute) !== expected) output.push(attribute);
        if (root.querySelectorAll(".tcrn-stepper").length > 0) output.push("stepper-numeric-entry");
        for (const input of root.querySelectorAll('[data-number-input-component="NumberInput"]')) {
          if (!input.classList.contains("tcrn-number-input")) output.push("number-input-identity");
          if (input.getAttribute("data-number-input-visibility") !== "full-value") output.push("number-input-visibility");
          if (input.type !== "number" || input.getAttribute("min") === null || input.getAttribute("value") === null) output.push("number-input-native-range");
        }
        return output;
      };
      assert.deepEqual(findings(layout), [], "the fixed candidate's structural proof must be green while coordination remains pending");

      layout.removeAttribute("data-settings-layout-form-policy");
      assert.ok(findings(layout).includes("data-settings-layout-form-policy"), "missing single-column policy must red");
      layout.setAttribute("data-settings-layout-form-policy", "single-host-single-column");

      const numberInput = layout.querySelector('[data-number-input-component="NumberInput"]');
      numberInput.classList.remove("tcrn-number-input");
      numberInput.removeAttribute("data-number-input-visibility");
      assert.ok(findings(layout).includes("number-input-identity") && findings(layout).includes("number-input-visibility"), "a NumberInput lookalike must red");
      numberInput.classList.add("tcrn-number-input");
      numberInput.setAttribute("data-number-input-visibility", "full-value");

      const stepper = page.document.createElement("div");
      stepper.className = "tcrn-stepper";
      layout.append(stepper);
      assert.ok(findings(layout).includes("stepper-numeric-entry"), "a Stepper numeric mutation must red");
      stepper.remove();
      assert.deepEqual(findings(layout), [], "restoring the candidate must return the positive proof to green");
    } finally { await page.cleanup(); }
  });
}
if (!MUTATION) {

  test("TCRN-CROSS-STORY-407/409/411 R3 consumes DS116-119 operation, scope, and evidence markers", async () => {
    const page = await preparePage();
    try {
      const feedback = page.document.querySelector("#operation-feedback");
      assert.ok(feedback, "the receipt drawer must expose the DS OperationFeedback root");
      assert.deepEqual({
        phase: feedback.getAttribute("data-operation-phase"),
        state: feedback.getAttribute("data-operation-state"),
        geometry: feedback.getAttribute("data-operation-geometry"),
        notification: feedback.getAttribute("data-operation-update-notification"),
        live: feedback.getAttribute("aria-live"),
      }, { phase: "idle", state: "idle", geometry: "responsive-safe", notification: "aria-live", live: "polite" });
      assert.ok(feedback.querySelector('[data-operation-short-status="true"]'));
      assert.ok(feedback.querySelector('[data-operation-identity="true"]'));
      const detailsTrigger = feedback.querySelector('[data-operation-details-trigger="true"]');
      const details = feedback.querySelector('[data-operation-details="true"]');
      assert.ok(detailsTrigger && details);
      assert.equal(details.hidden, true);
      detailsTrigger.click();
      assert.equal(details.hidden, false);
      assert.equal(detailsTrigger.getAttribute("aria-expanded"), "true");
      detailsTrigger.click();
      assert.equal(details.hidden, true);

      // TCRN-CROSS-SUB-409 (STORY-508 R5): a settings group is one ContentScope over the rows of both
      // catalogs. The atelier group holds the four portal preferences, every one of them this device's.
      page.document.querySelector('[data-setting-group="atelier"]')?.click();
      await new Promise((resolve) => setTimeout(resolve, 80));
      const scope = page.document.querySelector('[data-content-scope="settings-group"]');
      assert.ok(scope, "a settings group must consume the ContentScope contract");
      assert.equal(page.document.querySelectorAll('[data-content-scope="settings-group"]').length, 1, "one group is shown at a time");
      assert.deepEqual({
        group: scope.getAttribute("data-content-group"),
        source: scope.getAttribute("data-content-source"),
        phase: scope.getAttribute("data-content-phase"),
        valid: scope.getAttribute("data-content-valid"),
        shown: scope.getAttribute("data-content-shown-count"),
        total: scope.getAttribute("data-content-total-count"),
        countKind: scope.getAttribute("data-content-count-kind"),
        stale: scope.getAttribute("data-content-stale"),
      }, { group: "atelier", source: "engine.settings-catalog engine.machine-settings", phase: "content", valid: "true", shown: "4", total: "4", countKind: "total", stale: "false" });
      assert.equal(scope.querySelectorAll("[data-machine-row]").length, 4);
      assert.equal(scope.querySelectorAll("[data-setting-row]").length, 0);
      assert.equal(scope.querySelectorAll(".tcrn-content-scope__content").length, 1);
      assert.equal(page.document.querySelector("#settings-rows .tcrn-state-surface"), null, "a group with rows supplies no empty state");

      const chip = page.document.querySelector("#receipt-chip");
      const control = page.document.querySelector('[data-machine-control="portal.defaultTheme"]');
      assert.ok(chip && control);
      control.value = control.value === "dark" ? "light" : "dark";
      control.dispatchEvent(new page.window.Event("change", { bubbles: true }));
      await waitFor(() => feedback.getAttribute("data-operation-phase") === "success" ? "success" : null, "the operation feedback receipt update");
      assert.equal(feedback.getAttribute("data-operation-phase"), "success");
      assert.equal(feedback.getAttribute("data-operation-state"), "ready");
      assert.equal(feedback.querySelector('[data-operation-short-status="true"]')?.getAttribute("data-operation-short-status-phase"), "success");
      assert.ok(feedback.querySelector('[data-operation-identity-field="actor"]')?.textContent);
      assert.match(page.document.querySelector("#receipt-body")?.textContent ?? "", /MACHINE_SETTINGS_WRITE_COMMITTED/u);
    } finally { await page.cleanup(); }
  });
}
if (!MUTATION) {

  test("TCRN-CROSS-STORY-406 renders every current route as two levels and rejects a third-level or reordered mutation", async () => {
    const page = await preparePage();
    const source = await readFile(join(portalRoot, "index.html"), "utf8");
    try {
      assert.deepEqual(pageHierarchyFindings(page.document, source), [], "current routes must use Header + subpage controls + lower content");

      const settings = page.document.querySelector('[data-page="settings"]');
      const settingsHierarchy = settings.querySelector('[data-page-hierarchy="true"]');
      settingsHierarchy.removeAttribute("data-page-hierarchy");
      assert.ok(pageHierarchyFindings(page.document, source).includes("settings:page-level"), "a missing level declaration must red");
      settingsHierarchy.setAttribute("data-page-hierarchy", "true");

      const grid = settings.querySelector("[data-settings-layout-grid]");
      const nav = settings.querySelector("[data-settings-layout-nav]");
      const content = settings.querySelector("[data-settings-layout-content]");
      const settingsTabsRegion = settingsHierarchy.querySelector('[data-page-hierarchy-region="section-tabs"]');
      grid.append(nav);
      assert.ok(pageHierarchyFindings(page.document, source).includes("settings:tabs-before-content"), "a local-nav-after-content mutation must red");
      settingsTabsRegion.append(nav);
      assert.deepEqual(pageHierarchyFindings(page.document, source), [], "restoring the two-level order must return green");
    } finally { await page.cleanup(); }
  });
}
if (!MUTATION) {

  test("TCRN-CROSS-STORY-407 binds each product topbar control to its complete DS address and rejects duplicate or unbound controls", async () => {
    const page = await preparePage();
    try {
      assert.deepEqual(topbarFindings(page.document), [], "the topbar mapping must be structurally complete");

      const header = page.document.querySelector("header.tcrn-top-bar");
      const duplicate = header.cloneNode(true);
      header.parentElement.append(duplicate);
      assert.ok(topbarFindings(page.document).includes("product-shell-header:count"), "a duplicate product shell header must red");
      duplicate.remove();

      const receipt = page.document.querySelector("#receipt-chip");
      const receiptParent = receipt.parentElement;
      receipt.remove();
      assert.ok(topbarFindings(page.document).includes("receipt-chip:count"), "a missing mapped action must red");
      receiptParent.append(receipt);
      assert.deepEqual(topbarFindings(page.document), [], "restoring the mapped action must return green");

      header.removeAttribute("data-ds-source-url");
      assert.ok(topbarFindings(page.document).includes("product-shell-header:source-url"), "a self-reported but incomplete DS binding must red");
    } finally { await page.cleanup(); }
  });
}
if (!MUTATION) {

  test("TCRN-CROSS-STORY-407/411 R2-W1 gives every tablist DS keyboard and tabpanel semantics", async () => {
    const page = await preparePage();
    try {
      const keydown = (target, key) => {
        const event = new page.window.Event("keydown", { bubbles: true, cancelable: true });
        Object.defineProperty(event, "key", { value: key });
        target.dispatchEvent(event);
      };
      const tabLists = [...page.document.querySelectorAll('[role="tablist"]')];
      assert.equal(tabLists.length, 3, "dashboard, settings, and vocabulary must all expose a tablist");
      for (const list of tabLists) {
        const tabs = [...list.querySelectorAll('[role="tab"]')];
        assert.ok(tabs.length > 1, "each tablist must expose its complete tab set");
        assert.equal(tabs.filter((tab) => tab.getAttribute("aria-selected") === "true").length, 1, "each tablist has one selected tab");
        assert.equal(tabs.filter((tab) => tab.getAttribute("tabindex") === "0").length, 1, "each tablist has one tabbable tab");
        for (const tab of tabs) {
          assert.ok(tab.id, "each tab has a stable id");
          assert.equal(tab.getAttribute("aria-current"), null, "a real tab must not announce a page-current navigation state");
          assert.ok(tab.getAttribute("aria-controls"), "each tab controls a panel");
          const panel = page.document.getElementById(tab.getAttribute("aria-controls"));
          assert.equal(panel?.getAttribute("role"), "tabpanel", "each tab target is a tabpanel");
        }
        const selected = tabs.find((tab) => tab.getAttribute("aria-selected") === "true");
        const panel = page.document.getElementById(selected.getAttribute("aria-controls"));
        assert.equal(panel?.getAttribute("aria-labelledby"), selected.id, "the selected tab labels its panel");
      }

      // TCRN-CROSS-SUB-409: the groups come from the catalogs, general first and atelier last.
      const settingsList = page.document.querySelector('[data-settings-layout-nav]');
      const general = settingsList.querySelector('[data-setting-group="general"]');
      keydown(general, "ArrowRight");
      const models = settingsList.querySelector('[data-setting-group="models"]');
      assert.equal(models.getAttribute("aria-selected"), "true", "ArrowRight selects the next settings group");
      assert.equal(page.document.getElementById("settings-panel").getAttribute("aria-labelledby"), models.id);
      keydown(models, "Home");
      assert.equal(general.getAttribute("aria-selected"), "true", "Home selects the first settings group");
      const atelier = settingsList.querySelector('[data-setting-group="atelier"]');
      keydown(general, "End");
      assert.equal(atelier.getAttribute("aria-selected"), "true", "End selects the last settings group");
      assert.equal(page.document.getElementById("settings-panel").getAttribute("aria-labelledby"), atelier.id);

      const dashboardList = page.document.querySelector('[data-ui="workspace-tabs"]');
      const overview = dashboardList.querySelector('[data-workspace-tab="overview"]');
      keydown(overview, "ArrowRight");
      const work = dashboardList.querySelector('[data-workspace-tab="work"]');
      assert.equal(work.getAttribute("aria-selected"), "true", "dashboard ArrowRight selects the next panel");
      assert.equal(page.document.querySelector('[data-workspace-panel="work"]').hidden, false);
      assert.equal(page.document.querySelector('[data-workspace-panel="overview"]').hidden, true);
      keydown(work, "End");
      // TCRN-CROSS-SUB-513 (TCRN-CROSS-STORY-541): the Library tab is the final panel.
      const library = dashboardList.querySelector('[data-workspace-tab="library"]');
      assert.equal(library.getAttribute("aria-selected"), "true", "dashboard End selects the final panel");
      assert.equal(page.document.querySelector('[data-workspace-panel="library"]').hidden, false);
      keydown(library, "Home");
      assert.equal(overview.getAttribute("aria-selected"), "true");

      page.document.querySelector('[data-page-target="vocabulary"]')?.click();
      const vocabularyList = page.document.querySelector("#vocabulary-nav");
      const vocabularyTabs = [...vocabularyList.querySelectorAll('[role="tab"]')];
      const firstVocabularyTab = vocabularyTabs[0];
      keydown(firstVocabularyTab, "ArrowRight");
      const selectedVocabularyTab = [...vocabularyList.querySelectorAll('[role="tab"]')]
        .find((tab) => tab.getAttribute("aria-selected") === "true");
      assert.notEqual(selectedVocabularyTab, firstVocabularyTab, "vocabulary ArrowRight selects the next category");
      const vocabularyPanel = page.document.getElementById(selectedVocabularyTab.getAttribute("aria-controls"));
      assert.equal(vocabularyPanel.getAttribute("role"), "tabpanel");
      assert.equal(vocabularyPanel.getAttribute("aria-labelledby"), selectedVocabularyTab.id);
      keydown(selectedVocabularyTab, "End");
      const lastVocabularyTab = [...vocabularyList.querySelectorAll('[role="tab"]')]
        .find((tab) => tab.getAttribute("aria-selected") === "true");
      assert.equal(lastVocabularyTab, [...vocabularyList.querySelectorAll('[role="tab"]')].at(-1), "vocabulary End selects the final category");
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

  test("TCRN-CROSS-STORY-410 gives every vocabulary value a distinct five-locale definition and shows each category explanation once", async () => {
    const page = await preparePage();
    try {
      page.document.querySelector('[data-page-target="vocabulary"]')?.click();
      const categories = [
        "hosts",
        "conferenceTypes",
        "executionForms",
        "setting:artifact.language",
      ];
      for (const locale of ["en", "zh-CN", "ja", "ko", "fr"]) {
        page.document.querySelector(`[data-locale-option="${locale}"]`)?.click();
        await new Promise((resolve) => setTimeout(resolve, 40));
        for (const category of categories) {
          const button = page.document.querySelector(`[data-vocabulary-category="${category}"]`);
          assert.ok(button, `${locale} must keep the ${category} vocabulary category`);
          button.dispatchEvent(new page.window.Event("click", { bubbles: true }));
          const terms = page.document.querySelector("#vocabulary-terms");
          const categoryDescription = terms.querySelector(`[data-vocabulary-category-description="${category}"]`);
          assert.equal(terms.querySelectorAll("[data-vocabulary-category-description]").length, 1, `${locale}/${category} must show one category explanation`);
          assert.ok(categoryDescription?.textContent.trim() && !/^(?:vocabulary|setting)\./u.test(categoryDescription.textContent.trim()), `${locale}/${category} category explanation must be localized`);
          const rows = [...terms.querySelectorAll(".tcrn-table-shell__row")];
          assert.ok(rows.length > 0, `${locale}/${category} must render its engine values`);
          const descriptions = rows.map((row) => row.children[1]?.textContent.trim() ?? "");
          assert.ok(descriptions.every((description) => description.length > 0 && !/^(?:vocabulary|setting)\./u.test(description)), `${locale}/${category} values must have localized definitions`);
          assert.equal(new Set(descriptions).size, descriptions.length, `${locale}/${category} values must not collapse to one repeated description`);
          assert.ok(descriptions.every((description) => description !== categoryDescription.textContent.trim()), `${locale}/${category} values must not repeat the category explanation`);
        }
      }
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

  test("TCRN-CROSS-STORY-409 R2 covers default, modified, reset, page-switch, disabled, and invalid-value lifecycle states", async () => {
    const page = await preparePage();
    try {
      const selectGroup = (group) => page.document.querySelector(`[data-setting-group="${group}"]`)?.click();
      const waitForReceiptChange = async (before, label) => waitFor(receiptAdvanced(page.document, before), label);
      selectGroup("execution");

      const defaultRow = page.document.querySelector('[data-setting-row="execution.maxConcurrentSubagents"]');
      assert.equal(defaultRow?.dataset.modified, "false", "an unchanged open field starts in its default state");
      const concurrency = defaultRow.querySelector('[data-setting-control="execution.maxConcurrentSubagents"]');
      const beforeModify = receiptText(page.document);
      concurrency.value = "7";
      concurrency.dispatchEvent(new page.window.Event("change", { bubbles: true }));
      await waitForReceiptChange(beforeModify, "the modified open-field receipt");
      await waitFor(() => page.document.querySelector('[data-setting-row="execution.maxConcurrentSubagents"]')?.dataset.modified === "true", "the modified field to read back");
      const modifiedRow = page.document.querySelector('[data-setting-row="execution.maxConcurrentSubagents"]');
      assert.equal(modifiedRow?.dataset.modified, "true");
      assert.ok(modifiedRow?.querySelector("[data-reset-setting]"), "a modified field exposes reset");

      const beforeReset = receiptText(page.document);
      modifiedRow.querySelector("[data-reset-setting]").click();
      await waitForReceiptChange(beforeReset, "the open-field reset receipt");
      await waitFor(() => page.document.querySelector('[data-setting-row="execution.maxConcurrentSubagents"]')?.dataset.modified === "false", "the reset field to read back");
      assert.equal(page.document.querySelector('[data-setting-row="execution.maxConcurrentSubagents"]')?.dataset.modified, "false", "reset returns the field to the engine default");
      assert.equal((await cli(["settings-catalog", "--workspace", page.workspace], page.deviceEnv)).settings.find((entry) => entry.key === "execution.maxConcurrentSubagents").currentValue, "8");

      // A global-search jump uses the shared transient row treatment and ordinary
      // navigation clears it; the target isn't a portal-owned highlight class.
      const globalSearch = page.document.querySelector("#global-search");
      globalSearch.value = "execution.maxConcurrentSubagents";
      globalSearch.dispatchEvent(new page.window.Event("input", { bubbles: true }));
      const searchTarget = page.document.querySelector("#search-results [data-search-index]");
      assert.ok(searchTarget, "the setting remains discoverable through global search");
      searchTarget.click();
      const searchedRow = page.document.querySelector('[data-setting-row="execution.maxConcurrentSubagents"]');
      assert.equal(searchedRow?.getAttribute("data-transient-target"), "true", "a settings search result marks its target row");
      assert.equal(searchedRow?.classList.contains("tcrn-highlight"), false, "the target treatment does not add a portal highlight class");
      page.document.querySelector('[data-page-target="dashboard"]')?.click();
      assert.equal(page.document.querySelectorAll('[data-transient-target="true"]').length, 0, "navigation clears a settings search target");

      // TCRN-CROSS-SUB-409: prompt languages sit in the retrieval group, the port in atelier, the
      // segment size in storage (their catalog rows say so). TCRN-CROSS-SUB-310 R17: the invalid-value
      // state is proven on storage.segmentBytes, since knowledge.aggregateBytes left the catalog.
      selectGroup("retrieval");
      page.document.querySelector('[data-locale-option="en"]')?.click();
      page.document.querySelector('[data-setting-group="retrieval"]')?.click();
      const prompt = page.document.querySelector('[data-setting-control="retrieval.promptLanguages"]');
      assert.equal(prompt?.closest("[data-prompt-language-dropdown]").dataset.choicePresentation, "dropdown");
      assert.equal(prompt.closest("[data-setting-row]").querySelector("[data-reset-setting]"), null, "default state has no Reset override action");
      const languages = [...prompt.options];
      for (const option of languages) option.selected = true;
      const beforeSet = receiptText(page.document);
      prompt.dispatchEvent(new page.window.Event("change", { bubbles: true }));
      page.document.querySelector('[data-save-setting-choice="retrieval.promptLanguages"]').click();
      await waitForReceiptChange(beforeSet, "the prompt-language collection receipt");
      await waitFor(() => page.document.querySelector('[data-setting-row="retrieval.promptLanguages"]')?.dataset.modified === "true", "the prompt-language collection to read back");
      assert.equal((await cli(["settings-catalog", "--workspace", page.workspace], page.deviceEnv)).settings.find((entry) => entry.key === "retrieval.promptLanguages").currentValue, "en,fr,ja,ko,zh-CN");

      const resetLabels = new Map([
        ["zh-CN", "使用生成物语言"], ["en", "Use artefact language"], ["ja", "生成物の言語を使用"],
        ["ko", "산출물 언어 사용"], ["fr", "Utiliser la langue des artefacts"],
      ]);
      for (const [locale] of resetLabels) {
        page.document.querySelector(`[data-locale-option="${locale}"]`)?.click();
        page.document.querySelector('[data-setting-group="retrieval"]')?.click();
        assert.equal(page.document.querySelector('[data-setting-control="retrieval.promptLanguages"]')?.closest("[data-setting-row]").querySelector(".tcrn-setting-row__tools [data-reset-setting]")?.textContent, page.window.PORTAL_LOCALES[locale]["config.reset"], `${locale} reset label`);
        assert.equal(page.document.querySelector('[data-setting-row="retrieval.promptLanguages"]').querySelectorAll("[data-reset-setting]").length, 1, "one reset action belongs to the row");
      }
      page.document.querySelector('[data-locale-option="en"]')?.click();
      page.document.querySelector('[data-setting-group="retrieval"]')?.click();
      page.document.querySelector('[data-page-target="dashboard"]')?.click();
      page.document.querySelector('[data-page-target="settings"]')?.click();
      assert.equal([...page.document.querySelector('[data-setting-control="retrieval.promptLanguages"]').options].every((option) => option.selected), true, "page switching preserves the live collection state");

      const currentPrompt = page.document.querySelector('[data-setting-control="retrieval.promptLanguages"]');
      const beforeCollectionReset = receiptText(page.document);
      currentPrompt.closest("[data-setting-row]").querySelector('.tcrn-setting-row__tools [data-reset-setting="retrieval.promptLanguages"]').click();
      await waitForReceiptChange(beforeCollectionReset, "the prompt-language collection reset receipt");
      await waitFor(() => page.document.querySelector('[data-setting-row="retrieval.promptLanguages"]')?.dataset.modified === "false", "the prompt-language reset to read back");
      assert.equal((await cli(["settings-catalog", "--workspace", page.workspace], page.deviceEnv)).settings.find((entry) => entry.key === "retrieval.promptLanguages").currentValue, null, "the reset action restores the artifact-language default rather than writing an empty value");

      selectGroup("atelier");
      // TCRN-CROSS-STORY-482 R3: the fixture registry holds two libraries, so the switcher is live.
      assert.equal(page.document.querySelector("#library-select")?.disabled, false, "two registered libraries enable the library switcher");
      assert.equal(page.document.querySelectorAll("#library-select option").length, 2);
      assert.match(page.document.querySelector('[data-machine-row="portal.port"]')?.textContent ?? "", /restart/u, "the machine port exposes its restart lifecycle");

      selectGroup("knowledge");
      assert.equal(page.document.querySelector('[data-setting-row="knowledge.aggregateBytes"]'), null, "the retired knowledge total has no row");
      selectGroup("storage");
      const numeric = page.document.querySelector('[data-setting-control="storage.segmentBytes"]');
      const beforeInvalid = receiptText(page.document);
      numeric.value = "1024";
      numeric.dispatchEvent(new page.window.Event("change", { bubbles: true }));
      await waitFor(() => receiptText(page.document) !== beforeInvalid && receiptText(page.document).startsWith("✕"), "the invalid-value receipt");
      assert.equal(page.document.querySelector('[data-setting-row="storage.segmentBytes"]')?.dataset.modified, "false", "an engine-rejected value does not change the field");
      assert.equal((await cli(["settings-catalog", "--workspace", page.workspace], page.deviceEnv)).settings.find((entry) => entry.key === "storage.segmentBytes").currentValue, "1048576");
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

  test("TCRN-CROSS-STORY-408 R2 consumes the DS static overlay boundary for short and long explanations", async () => {
    const page = await preparePage();
    try {
      page.document.querySelector('[data-setting-group="general"]')?.click();
      await new Promise((resolve) => setTimeout(resolve, 80));
      const longTip = page.document.querySelector('[data-concept-tip="setting.design.authority"]');
      assert.ok(longTip, "the general group must expose the long overlay consumer");
      const inspect = (tip) => {
        const trigger = tip.querySelector("button");
        const id = trigger?.getAttribute("aria-controls") || trigger?.getAttribute("aria-describedby");
        const layer = id ? page.document.getElementById(id) : null;
        assert.ok(trigger && layer, "every overlay trigger must resolve its layer by id");
        assert.equal(layer.parentElement, page.document.body, "every layer must escape the settings row boundary");
        assert.equal(layer.getAttribute("data-overlay-boundary"), "document-body");
        assert.equal(layer.getAttribute("data-overlay-positioning"), "static-fixed");
        assert.equal(layer.getAttribute("data-ds-overlay-candidate"), `TCRN-Design-System@${DS_CONTRACT.candidate}`);
        assert.equal(layer.hidden, true);
        return { trigger, layer };
      };
      const long = inspect(longTip);
      assert.equal(long.trigger.getAttribute("aria-haspopup"), "dialog");
      long.trigger.dispatchEvent(new page.window.Event("click", { bubbles: true }));
      assert.equal(long.layer.hidden, false);
      const closeLong = new page.window.Event("keydown", { bubbles: true });
      Object.defineProperty(closeLong, "key", { value: "Escape" });
      page.document.dispatchEvent(closeLong);
      assert.equal(long.layer.hidden, true);

      page.document.querySelector('[data-setting-group="execution"]')?.click();
      await new Promise((resolve) => setTimeout(resolve, 80));
      const shortTip = page.document.querySelector('[data-concept-tip="setting.execution.maxConcurrentSubagents"]');
      assert.ok(shortTip, "the execution group must expose the short overlay consumer");
      const short = inspect(shortTip);
      assert.equal(short.trigger.getAttribute("aria-describedby"), short.layer.getAttribute("id"));
      assert.equal(short.layer.getAttribute("role"), "tooltip");
      short.trigger.dispatchEvent(new page.window.Event("focusin", { bubbles: true }));
      assert.equal(short.layer.hidden, false, "the short tooltip opens from keyboard focus");
      const closeShort = new page.window.Event("keydown", { bubbles: true });
      Object.defineProperty(closeShort, "key", { value: "Escape" });
      page.document.dispatchEvent(closeShort);
      assert.equal(short.layer.hidden, true, "Escape closes the short tooltip");
    } finally { await page.cleanup(); }
  });
}
if (!MUTATION) {

  test("INC-186 the dictionary carries no workspace data", async () => {
    const page = await preparePage();
    try {
      // The fixture creates a plan named "budget" (the setting that bound it retired with
      // TCRN-CROSS-STORY-484 R3), so if the dictionary drew its values from the plan list this
      // sweep would find that name.
      // That is the whole defect: the dictionary grew a row because the reader created
      // a plan, which is the portal inventing vocabulary rather than publishing it.
      const names = [...page.document.querySelectorAll("[data-vocabulary-category]")].map((button) => button.dataset.vocabularyCategory);
      assert.ok(!names.includes("setting:execution.claudeCodeSubagentPlan"), "a setting whose values are plan names has no closed set to define");
      assert.ok(!names.includes("setting:execution.codexSubagentPlan"));
      // Both sides: settings the engine does publish a closed set for keep their entries.
      assert.ok(names.includes("setting:artifact.language"));

      for (const name of names) {
        page.document.querySelector(`[data-vocabulary-category="${name}"]`).dispatchEvent(new page.window.Event("click", { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 40));
        const rendered = page.document.querySelector("#vocabulary-terms")?.textContent ?? "";
        assert.ok(!rendered.includes("budget"), `workspace data leaked into the ${name} entry`);
      }

      // The 📖 link and the dictionary answer the same question, so the link is present
      // exactly where an entry exists to reach and absent where none does.
      page.document.querySelector('[data-setting-group="knowledge"]')?.click();
      await new Promise((resolve) => setTimeout(resolve, 60));
      const languageRow = page.document.querySelector('[data-setting-row="artifact.language"]');
      assert.ok(languageRow?.querySelector("[data-vocabulary-link]"), "a closed-enum setting keeps its dictionary link");
      page.document.querySelector('[data-setting-group="execution"]')?.click();
      await new Promise((resolve) => setTimeout(resolve, 60));
      const planRow = page.document.querySelector('[data-setting-row="execution.claudeCodeSubagentPlan"]');
      if (planRow) assert.equal(planRow.querySelector("[data-vocabulary-link]"), null, "a plan-sourced setting must not offer a link to an entry that does not exist");
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
if (!MUTATION) {

  test("STORY-379 GWT2/GWT3: work and knowledge views are reachable, read-only, and translated", async () => {
    const page = await preparePage();
    try {
      page.document.querySelector('[data-page-target="dashboard"]')?.click();
      // STORY-485 adds a standalone gate page, outside the work dashboard tabs.
      assert.ok(page.document.querySelector('[data-ui="gates-view"]'));
      assert.equal(page.document.querySelector('[data-workspace-tab="gates"], [data-workspace-panel="gates"]'), null);
      for (const target of ["work", "knowledge"]) {
        page.document.querySelector(`[data-workspace-tab="${target}"]`)?.click();
        await new Promise((resolve) => setTimeout(resolve, 40));
        assert.equal(page.document.querySelector(`[data-workspace-panel="${target}"]`)?.hidden, false, `${target} panel must be reachable`);
      }
      // TCRN-CROSS-SUB-425 (MIN-239 D6): the knowledge list reads valid cards unless the viewer picks
      // another status; the filter offers the three statuses, valid selected.
      const status = page.document.querySelector('[data-ui="knowledge-status-filter"]');
      assert.deepEqual([...(status?.querySelectorAll("option") ?? [])].map((option) => option.value), ["valid", "removed", "all"]);
      assert.equal(status?.value, "valid");
      for (const locale of ["en", "zh-CN", "ja", "ko", "fr"]) {
        page.document.querySelector(`[data-locale-option="${locale}"]`)?.click();
        await new Promise((resolve) => setTimeout(resolve, 40));
        assert.equal(page.document.documentElement.lang, locale);
        for (const key of ["dashboard.workTitle", "dashboard.knowledgeTitle"]) {
          assert.notEqual(page.document.querySelector(`[data-i18n="${key}"]`)?.textContent, key);
        }
      }
    } finally { await page.cleanup(); }
  });
}
if (!MUTATION) {

  test("STORY-482 R3: work view renders the initiatives in the selected library", async () => {
    const fixture = await scratch("tcrn-482-work-view-");
    const project = await cli([
      "project-create", "--workspace", fixture.workspace, "--at", nextAt(),
      "--external-key", "PORTAL-STATUS-PROJECT", "--name", "Portal status project",
    ], fixture.deviceEnv);
    const initiative = await cli([
      "work-create", "--workspace", fixture.workspace, "--at", nextAt(), "--project-id", project.record.id,
      "--external-key", "PORTAL-STATUS-INIT", "--kind", "Initiative", "--title", "Portal status work",
    ], fixture.deviceEnv);
    const epic = await cli([
      "work-create", "--workspace", fixture.workspace, "--at", nextAt(), "--project-id", project.record.id,
      "--external-key", "PORTAL-STATUS-EPIC", "--kind", "Epic", "--parent-id", initiative.record.id, "--title", "Portal status epic",
    ], fixture.deviceEnv);
    const page = await loadExecutedDom(fixture);
    try {
      page.document.querySelector('[data-page-target="dashboard"]')?.click();
      page.document.querySelector('[data-workspace-tab="work"]')?.click();
      const initiativeRow = page.document.querySelector(`[data-work-id="${initiative.record.id}"]`);
      const epicRow = page.document.querySelector(`[data-work-id="${epic.record.id}"]`);
      assert.ok(initiativeRow);
      assert.ok(epicRow);
      assert.match(page.document.querySelector("#work-tree-content").textContent, /Portal status work[\s\S]*Portal status epic/u);
      assert.doesNotMatch(page.source, /TCRN-CROSS-INIT-051/u);
    } finally { page.child.kill(); await rm(fixture.base, { recursive: true, force: true }); }
  });
}
if (!MUTATION) {

  // TCRN-CROSS-STORY-482 R4: the evolution panel (conflict retirements, retrieval evaluation and the
  // host render state), the session audit (its tab, its button and its list in the receipt drawer)
  // and the execution surface left with the mechanisms they showed. The page neither renders them
  // nor asks the server for them; the receipt drawer keeps the engine's receipt.
  test("STORY-482 R4: the evolution panel, the session audit and the host projection are gone from the page", async () => {
    const page = await preparePage();
    try {
      const tabs = [...page.document.querySelectorAll("[data-workspace-tab]")].map((tab) => tab.dataset.workspaceTab);
      // TCRN-CROSS-SUB-513 (TCRN-CROSS-STORY-541) adds the Library tab: chain identity and the registry.
      assert.deepEqual(tabs, ["overview", "work", "knowledge", "library"]);
      assert.deepEqual([...page.document.querySelectorAll("[data-workspace-panel]")].map((panel) => panel.dataset.workspacePanel), tabs);
      for (const selector of ['[data-ui="evolution-dashboard"]', "#evolution-retirement", "#evolution-eval", "#evolution-hosts", "#audit-button", "#dashboard-audit", "#drawer-audit", '[data-ui="dispatch-config-surface"]']) {
        assert.equal(page.document.querySelector(selector), null, `${selector} must be absent`);
      }
      const retired = ["evolution", ["session", "audit"].join("-"), ["host", "probe"].join("-"), "execution"].map((name) => `/api/${name}`);
      assert.ok(page.requests.length > 0, "the harness records the page's requests");
      assert.deepEqual(page.requests.filter((path) => retired.some((route) => path.startsWith(route))), [], "the page asks for no retired route");
      for (const route of retired) assert.equal(page.source.includes(`"${route}"`), false, `the page source names no ${route}`);
      page.document.querySelector('[data-ui="receipt-chip"]').click();
      page.document.querySelector("#receipt-details-trigger").click();
      const details = page.document.querySelector("#receipt-details");
      assert.equal(details.hidden, false);
      assert.ok(details.querySelector("#receipt-body.tcrn-readback-panel"), "the drawer keeps the engine receipt");
      assert.equal(details.querySelectorAll("h3").length, 0, "the drawer no longer lists this session's writes");
      assert.equal(page.document.querySelector("#drawer-button")?.textContent.trim(), "Operation record");
    } finally { await page.cleanup(); }
  });
}
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
    } finally { page.child.kill(); await rm(fixture.base, { recursive: true, force: true }); }
  });
}
if (!MUTATION) {

  // The narrow execution cards were the dispatch surface's host cards, which left with the
  // dispatch-* verbs (TCRN-CROSS-STORY-467 R3); the status receipt and tab label boundaries stay.
  test("STORY-389: status receipts and French tab labels keep their boundaries", async () => {
    const page = await preparePage();
    try {
      const source = await readFile(join(portalRoot, "index.html"), "utf8");
      assert.match(source, /@media \(max-width: 520px\)[\s\S]*?\.tcrn-app-status-bar__command[\s\S]*?white-space:\s*normal;/u);
      assert.doesNotMatch(source, /tcrn-dispatch-hosts|data-dispatch-host-card/u);
      for (const locale of ["fr", "en", "zh-CN", "ja", "ko"]) {
        page.document.querySelector(`[data-locale-option="${locale}"]`)?.click();
        const labels = [...page.document.querySelectorAll("[data-workspace-tab]")].map((tab) => tab.textContent.trim());
        assert.equal(new Set(labels).size, labels.length, `${locale} workspace tab labels must stay distinct: ${JSON.stringify(labels)}`);
      }
      // The Audit tab the French check pinned left with the session audit (TCRN-CROSS-STORY-482 R4).
      page.document.querySelector('[data-locale-option="fr"]')?.click();
      assert.equal(page.document.querySelector('[data-workspace-tab="knowledge"]')?.textContent, "Connaissances");
      page.document.querySelector('[data-locale-option="en"]')?.click();
      assert.equal(page.document.querySelector('[data-workspace-tab="knowledge"]')?.textContent, "Knowledge");
    } finally { await page.cleanup(); }
  });
}
if (!MUTATION) {

  // TCRN-CROSS-SUB-416 (TCRN-CROSS-STORY-510): refresh does not put /api/work in the wait the other
  // views share. The page asks for /api/work in one place, the work view's own read, which refresh
  // starts first and does not await; that read renders the work view and nothing else.
  test("SUB-416 (STORY-510): refresh's shared wait leaves /api/work out, and the work view reads it on its own", async () => {
    const source = await readFile(join(portalRoot, "index.html"), "utf8");
    const refresh = source.match(/\n {2}const refresh = async \(\) => \{\n([\s\S]*?)\n {2}\};\n/u)?.[1] ?? "";
    assert.match(refresh, /refreshWork\(\);[\s\S]*await Promise\.all\(\[/u, "refresh starts the work read, then waits for the other views' reads together");
    assert.doesNotMatch(refresh, /\/api\/work|await refreshWork/u, "neither /api/work nor the work read is in that wait");
    assert.equal(source.split('api("/api/work")').length - 1, 1, "the page asks for /api/work in one place");
    const refreshWork = source.match(/\n {2}const refreshWork = async \(\) => \{\n([\s\S]*?)\n {2}\};\n/u)?.[1] ?? "";
    assert.match(refreshWork, /work = await api\("\/api\/work"\)/u, "that place is the work view's own read");
    assert.match(refreshWork, /renderWorkView\(\)/u);
    assert.doesNotMatch(refreshWork, /render(?:Dashboard|Settings|Collections|Variables|Vocabulary|ProseDirectory)\(|showReceipt\(/u, "it renders the work view alone and leaves the receipt alone");
  });
}
if (!MUTATION) {

  // TCRN-CROSS-SUB-416 (TCRN-CROSS-STORY-510): /api/work is held back. Status, settings, the model
  // tables, variables and rules render while it is out, and the work view renders when it returns:
  // when the page opens, and again on the refresh a settings write asks for.
  test("SUB-416 (STORY-510): the views that read no work render while /api/work is out, and the work view when it returns", async () => {
    const fixture = await scratch("tcrn-416-refresh-dom-");
    const project = await cli(["project-create", "--workspace", fixture.workspace, "--at", nextAt(), "--external-key", "PORTAL-REFRESH-PROJECT", "--name", "Portal refresh project"], fixture.deviceEnv);
    const common = ["--workspace", fixture.workspace, "--project-id", project.record.id];
    const initiative = await cli(["work-create", ...common, "--at", nextAt(), "--external-key", "PORTAL-REFRESH-INIT", "--kind", "Initiative", "--title", "Portal refresh work"], fixture.deviceEnv);
    const epic = await cli(["work-create", ...common, "--at", nextAt(), "--external-key", "PORTAL-REFRESH-EPIC", "--kind", "Epic", "--parent-id", initiative.record.id, "--title", "Portal refresh epic"], fixture.deviceEnv);
    const status = await cli(["status", "--workspace", fixture.workspace], fixture.deviceEnv);
    const isWork = (path) => path === "/api/work";
    const page = await loadExecutedDom(fixture, {}, { hold: isWork });
    try {
      const { document } = page;
      const text = (selector) => document.querySelector(selector)?.textContent ?? "";
      const content = document.querySelector("#work-tree-content");
      const workShown = () => Boolean(document.querySelector(`[data-work-id="${initiative.record.id}"]`) && document.querySelector(`[data-work-id="${epic.record.id}"]`));
      assert.equal(page.held(), 1, "the page opened and asked for /api/work, which is still out");
      assert.equal(text("#stat-version"), String(status.version), "status rendered");
      assert.ok(document.querySelectorAll("[data-doctor-check]").length > 0, "the doctor checks rendered");
      assert.ok(document.querySelectorAll("#settings-rows [data-setting-row]").length > 0, "settings rendered");
      assert.notEqual(text("#model-categories-count"), "—", "the model categories rendered");
      assert.notEqual(text("#model-tiers-count"), "—", "the model tiers rendered");
      assert.notEqual(text("#variables-count"), "", "the variables rendered");
      assert.ok(document.querySelectorAll("#prose-directory [data-rule-card]").length > 0, "the rules rendered");
      assert.deepEqual([content.getAttribute("aria-busy"), text("#work-count"), content.innerHTML], ["true", "—", ""], "the work view waits for its own read");

      assert.equal(page.release(), 1);
      await page.waitForSettled();
      assert.equal(content.getAttribute("aria-busy"), "false");
      assert.match(text("#work-count"), /^1 /u);
      assert.equal(workShown(), true, "the work view rendered when /api/work returned");

      // A settings write asks for a refresh while /api/work is held again: the setting reads back
      // while the work read is out, and the work view keeps what it showed until that read returns.
      page.hold(isWork);
      document.querySelector('[data-page-target="settings"]')?.click();
      document.querySelector('[data-setting-group="execution"]')?.click();
      const control = document.querySelector('[data-setting-control="execution.maxConcurrentSubagents"]');
      const before = receiptText(document);
      control.value = "7";
      control.dispatchEvent(new page.window.Event("change", { bubbles: true }));
      await waitFor(receiptAdvanced(document, before), "the setting write receipt");
      await waitFor(() => document.querySelector('[data-setting-row="execution.maxConcurrentSubagents"]')?.dataset.modified === "true", "the setting to read back while /api/work is out");
      assert.equal(page.held(), 1, "the refresh asked for /api/work, which is still out");
      assert.equal(content.getAttribute("aria-busy"), "true");
      assert.equal(workShown(), true, "the work view keeps what it showed");
      assert.equal(page.release(), 1);
      await page.waitForSettled();
      assert.equal(content.getAttribute("aria-busy"), "false");
      assert.equal(workShown(), true);
    } finally { page.child.kill(); await rm(fixture.base, { recursive: true, force: true }); }
  });
}
if (!MUTATION) {

  // TCRN-CROSS-SUB-416 (TCRN-CROSS-STORY-510): a work read that fails is shown in the work view, and
  // only there. The engine's refusal comes back with both reason codes; a broken connection comes
  // back as PORTAL_READ_FAILED. Either way status reads on, the other views render, and no receipt
  // is raised for it.
  test("SUB-416 (STORY-510): a work read that fails is shown in the work view alone", async () => {
    const fixture = await scratch("tcrn-416-failure-dom-");
    try {
      const wrapper = join(fixture.base, "work-refused-wrapper.mjs");
      await writeFile(wrapper, `import { spawnSync } from "node:child_process";
if (process.argv[2] === "work-list") {
  process.stderr.write(JSON.stringify({ ok: false, reasonCode: "PORTAL_TEST_WORK_REFUSED", error: "the test refuses every work-list" }) + "\\n");
  process.exitCode = 1;
} else {
  const actual = spawnSync(process.execPath, [${JSON.stringify(CLI)}, ...process.argv.slice(2)], { encoding: "utf8", maxBuffer: 64e6 });
  process.stdout.write(actual.stdout || "");
  process.stderr.write(actual.stderr || "");
  process.exitCode = actual.status ?? 1;
}
`, "utf8");
      const status = await cli(["status", "--workspace", fixture.workspace], fixture.deviceEnv);
      const assertOnlyWorkFailed = (page, reasonCode) => {
        const text = (selector) => page.document.querySelector(selector)?.textContent ?? "";
        const failure = page.document.querySelector("#work-tree-content [data-work-failure]");
        assert.equal(failure?.getAttribute("role"), "alert");
        assert.equal(failure.dataset.workFailure, reasonCode);
        assert.equal(text("#work-count"), "—");
        assert.equal(text("#stat-version"), String(status.version), "status reads on");
        assert.ok(page.document.querySelectorAll("#settings-rows [data-setting-row]").length > 0, "settings rendered");
        assert.ok(page.document.querySelectorAll("#prose-directory [data-rule-card]").length > 0, "the rules rendered");
        assert.equal(page.document.querySelector("#operation-feedback")?.dataset.operationPhase, "idle", "no receipt is raised for the work read");
        return failure;
      };

      const refused = await loadExecutedDom(fixture, { TCRN_WORKFLOW_CLI: wrapper });
      try {
        const failure = assertOnlyWorkFailed(refused, "PORTAL_WORK_READ_FAILED");
        const complete = JSON.parse(failure.querySelector("pre").textContent);
        assert.equal(complete.reasonCode, "PORTAL_WORK_READ_FAILED");
        assert.equal(complete.source.reasonCode, "PORTAL_TEST_WORK_REFUSED");
        assert.equal(failure.querySelector("details").hasAttribute("open"), false, "technical reasons start inside a closed disclosure");
        const sandbox = {};
        new Function("window", await readFile(join(portalRoot, "locales.js"), "utf8"))(sandbox);
        for (const locale of Object.keys(sandbox.PORTAL_LOCALES)) {
          refused.document.querySelector(`[data-locale-option="${locale}"]`).click();
          const description = refused.document.querySelector("[data-work-failure] .tcrn-state-surface__description");
          assert.equal(description.textContent, sandbox.PORTAL_LOCALES[locale]["app.readUnavailable"]);
        }
      } finally { refused.child.kill(); }

      const broken = await loadExecutedDom(fixture, {}, { hold: (path) => path === "/api/work" });
      try {
        assert.equal(broken.release({ error: new TypeError("fetch failed") }), 1);
        await broken.waitForSettled();
        const failure = assertOnlyWorkFailed(broken, "PORTAL_READ_FAILED");
        const complete = JSON.parse(failure.querySelector("pre").textContent);
        assert.equal(complete.reasonCode, "PORTAL_READ_FAILED");
        assert.equal(complete.error, "Unable to read the response.");
        assert.equal(JSON.stringify(complete).includes("fetch failed"), false, "raw transport details are not exposed");
        assert.ok(failure.querySelector(".tcrn-state-surface__description").textContent.length > 0);
      } finally { broken.child.kill(); }
    } finally { await rm(fixture.base, { recursive: true, force: true }); }
  });
}
if (!MUTATION) {

  // TCRN-CROSS-SUB-424 (TCRN-CROSS-STORY-513 R3; MIN-238 D3): /api/work is held back. While the work
  // view's read of the library is out, the view says so on a status line in the page's language, and
  // the work tree stays aria-busy; the line goes when the read returns and the list shows. The other
  // views do not wait for the work read (SUB-416), and a refresh's read of the same library shows the
  // line again above the list the view keeps until that read returns.
  test("SUB-424 (STORY-513 R3, MIN-238 D3): the work view says it is reading while /api/work is out, in the page's language", async () => {
    const fixture = await scratch("tcrn-424-work-loading-dom-");
    const project = await cli(["project-create", "--workspace", fixture.workspace, "--at", nextAt(), "--external-key", "PORTAL-LOADING-PROJECT", "--name", "Portal loading project"], fixture.deviceEnv);
    const initiative = await cli(["work-create", "--workspace", fixture.workspace, "--project-id", project.record.id, "--at", nextAt(), "--external-key", "PORTAL-LOADING-INIT", "--kind", "Initiative", "--title", "Portal loading work"], fixture.deviceEnv);
    const status = await cli(["status", "--workspace", fixture.workspace], fixture.deviceEnv);
    const sandbox = {};
    new Function("window", await readFile(join(portalRoot, "locales.js"), "utf8"))(sandbox);
    const copy = (locale) => sandbox.PORTAL_LOCALES[locale]["dashboard.workLoading"];
    const isWork = (path) => path === "/api/work";
    const page = await loadExecutedDom(fixture, {}, { hold: isWork });
    try {
      const { document } = page;
      const text = (selector) => document.querySelector(selector)?.textContent ?? "";
      const content = document.querySelector("#work-tree-content");
      const line = document.querySelector("#work-loading");
      const listed = () => Boolean(content.querySelector(`[data-work-id="${initiative.record.id}"]`));
      document.querySelector('[data-page-target="dashboard"]')?.click();
      document.querySelector('[data-workspace-tab="work"]')?.click();
      await waitFor(() => document.querySelector('[data-workspace-panel="work"]')?.hidden === false, "the work tab to open");
      assert.equal(page.held(), 1, "the page asked for /api/work, which is still out");
      assert.equal(line?.getAttribute("role"), "status");
      assert.equal(line.hidden, false, "the reading line shows while the read is out");
      assert.equal(content.getAttribute("aria-busy"), "true", "the work tree stays busy");
      assert.deepEqual([text("#work-count"), content.innerHTML], ["—", ""], "nothing is listed before the first read returns");
      const seen = new Set();
      for (const locale of ["en", "zh-CN", "ja", "ko", "fr"]) {
        document.querySelector(`[data-locale-option="${locale}"]`)?.click();
        assert.equal(document.documentElement.lang, locale);
        assert.equal(line.textContent, copy(locale), `${locale}: the reading line is in the page's language`);
        assert.equal(line.hidden, false, `${locale}: the reading line still shows`);
        seen.add(line.textContent);
      }
      assert.equal(seen.size, 5, "each language has a reading line of its own");
      assert.equal(text("#stat-version"), String(status.version), "status did not wait for the work read");
      assert.ok(document.querySelectorAll("#settings-rows [data-setting-row]").length > 0, "settings did not wait for the work read");
      assert.ok(document.querySelectorAll("#prose-directory [data-rule-card]").length > 0, "the rules did not wait for the work read");

      assert.equal(page.release(), 1);
      await page.waitForSettled();
      assert.equal(line.hidden, true, "the reading line goes when the read returns");
      assert.equal(content.getAttribute("aria-busy"), "false");
      assert.equal(listed(), true, "the list shows when the read returns");

      // A settings write asks for a refresh while /api/work is held again: the line shows above the
      // list the view keeps, and goes when that read returns.
      page.hold(isWork);
      document.querySelector('[data-page-target="settings"]')?.click();
      document.querySelector('[data-setting-group="execution"]')?.click();
      const control = document.querySelector('[data-setting-control="execution.maxConcurrentSubagents"]');
      const before = receiptText(document);
      control.value = "7";
      control.dispatchEvent(new page.window.Event("change", { bubbles: true }));
      await waitFor(receiptAdvanced(document, before), "the setting write receipt");
      await waitFor(() => page.held() === 1, "the refresh's read of /api/work");
      document.querySelector('[data-page-target="dashboard"]')?.click();
      assert.equal(line.hidden, false, "the reading line shows again while the refresh's read is out");
      assert.equal(line.textContent, copy("fr"));
      assert.equal(content.getAttribute("aria-busy"), "true");
      assert.equal(listed(), true, "the view keeps its list while that read is out");
      assert.equal(page.release(), 1);
      await page.waitForSettled();
      assert.equal(line.hidden, true);
      assert.equal(content.getAttribute("aria-busy"), "false");
      assert.equal(listed(), true);
    } finally { page.child.kill(); await rm(fixture.base, { recursive: true, force: true }); }
  });
}


if (!MUTATION) test("R46 I12: a Subtask chooses only within its parent's projects, and a coordination-only parent allows none", async () => {
  const fixture = await scopedWorkFixture("tcrn-r46-i12-scope-");
  const [own, second, third] = fixture.targets;
  const key = (target) => JSON.stringify({ libraryId: target.libraryId, projectId: target.projectId });
  const locales = await localeTable();
  const page = await loadExecutedDom(fixture);
  try {
    const { document, window } = page;
    const editor = await openWorkEditor(page);
    const work = editor.querySelector("[data-target-work]");
    work.value = fixture.subtask.id;
    work.dispatchEvent(new window.Event("change", { bubbles: true }));
    await waitFor(() => editor.querySelector("[data-target-scope-note]"), "the parent's scope note");
    const native = (target) => [...editor.querySelectorAll(".tcrn-multi-select-dropdown__value option")].find((option) => option.value === key(target));
    const listed = (target) => [...document.querySelectorAll("#work-project-options [role=option]")].find((option) => option.dataset.multiSelectValue === key(target));
    for (const target of [own, third]) {
      assert.equal(native(target).hasAttribute("disabled"), true, "a project outside the parent cannot be chosen");
      const option = listed(target);
      assert.equal(option.hasAttribute("disabled"), true);
      assert.equal(option.getAttribute("aria-disabled"), "true");
      assert.equal(option.getAttribute("aria-describedby"), "work-project-scope-note", "and says why");
    }
    assert.equal(native(second).hasAttribute("disabled"), false, "the parent's project can be chosen");
    assert.equal(listed(second).hasAttribute("disabled"), false);
    const note = editor.querySelector("#work-project-scope-note");
    assert.equal(note.dataset.targetScopeNote, "selected");
    assert.equal(note.textContent, locales.en["projects.parentScope"].replace("{projects}", "TCRN-INC148-DOM-SECOND"));
    // A coordination-only parent: no project and no selected scope.
    work.value = fixture.coordinationSubtask.id;
    work.dispatchEvent(new window.Event("change", { bubbles: true }));
    await waitFor(() => editor.querySelector('[data-target-scope-note="coordination-only"]'), "the coordination-only note");
    assert.equal(editor.querySelector("#work-project-scope-note").textContent, locales.en["projects.parentCoordinationOnly"]);
    for (const target of [own, second, third]) assert.equal(native(target).hasAttribute("disabled"), true);
    assert.equal(editor.querySelector('[data-target-state] option[value="selected"]').hasAttribute("disabled"), true, "the selected scope is not offered");
    // The Story itself has an undecided parent (the Epic): nothing is limited.
    work.value = fixture.story.id;
    work.dispatchEvent(new window.Event("change", { bubbles: true }));
    await waitFor(() => editor.querySelector("[data-target-scope-note]") === null, "the unlimited Story");
    for (const target of [own, second, third]) assert.equal(native(target).hasAttribute("disabled"), false);
    // Five languages: the note follows the page's language.
    work.value = fixture.subtask.id;
    work.dispatchEvent(new window.Event("change", { bubbles: true }));
    for (const locale of ["zh-CN", "ja", "ko", "fr"]) {
      document.querySelector(`[data-locale-option="${locale}"]`)?.click();
      await waitFor(() => document.querySelector("#work-project-scope-note")?.textContent === locales[locale]["projects.parentScope"].replace("{projects}", "TCRN-INC148-DOM-SECOND"), `${locale}: the scope note`);
    }
  } finally { await closePage(page, fixture); }
});


// TCRN-CROSS-INIT-053 R46 (I12; U20 D6): a refused save says which refusal, in the engine's own words, and
// how to recover. The parent is narrowed elsewhere after the page read it, so the page's choice is stale.
if (!MUTATION) test("R46 I12: a refused relation shows its reason code, the engine's words and how to recover", async () => {
  const fixture = await scopedWorkFixture("tcrn-r46-i12-refusal-");
  const [, second] = fixture.targets;
  const key = JSON.stringify({ libraryId: second.libraryId, projectId: second.projectId });
  const locales = await localeTable();
  const page = await loadExecutedDom(fixture);
  try {
    const { document, window } = page;
    const editor = await openWorkEditor(page);
    const work = editor.querySelector("[data-target-work]");
    work.value = fixture.subtask.id;
    work.dispatchEvent(new window.Event("change", { bubbles: true }));
    await waitFor(() => editor.querySelector("[data-target-scope-note]"), "the subtask's editor");
    const story = (await cli(["work-list", "--workspace", fixture.workspace], fixture.deviceEnv)).records.find((record) => record.id === fixture.story.id);
    await cli(["work-annotate", "--workspace", fixture.workspace, "--at", nextAt(), "--actor", "agent:test", "--id", story.id, "--expected-revision", String(story.revision), "--involved-projects", JSON.stringify({ state: "coordination-only", targets: [] })], fixture.atelier);
    editor.querySelector("[data-target-state]").value = "selected";
    [...editor.querySelectorAll(".tcrn-multi-select-dropdown__value option")].find((option) => option.value === key).setAttribute("selected", "");
    editor.querySelector("[data-target-save]").click();
    const refusal = await waitFor(() => editor.querySelector("[data-target-refusal]"), "the refusal");
    assert.equal(refusal.dataset.targetRefusal, "WORKSPACE_INPUT_INVALID");
    assert.ok(refusal.classList.contains("tcrn-inline-alert") && refusal.classList.contains("tcrn-inline-alert--danger"));
    assert.equal(refusal.querySelector("code").textContent, "WORKSPACE_INPUT_INVALID");
    assert.equal(refusal.querySelector("[data-target-refusal-engine]").textContent, "child projects exceed the declared parent scope", "the engine's own words");
    assert.equal(refusal.querySelector("[data-target-refusal-engine]").getAttribute("lang"), "en");
    assert.equal(refusal.querySelector("[data-target-refusal-recovery]").textContent, locales.en["projects.recoverScope"]);
    assert.match(receiptText(document), /^✕/u);
    const subtask = (await cli(["work-list", "--workspace", fixture.workspace], fixture.deviceEnv)).records.find((record) => record.id === fixture.subtask.id);
    assert.equal(subtask.involvedProjects?.state ?? "undecided", "undecided", "nothing was saved");
  } finally { await closePage(page, fixture); }
});


// TCRN-CROSS-INIT-053 R46 (I16; approved contract items 5, 9): Subtasks are listed under their Story, built as
// the Story row is, each naming the projects it involves; the project filter keeps them with their parents.
if (!MUTATION) test("R46 I16: Subtasks are listed under their Story with the projects they involve, and the filter keeps them", async () => {
  const fixture = await projectChainFixture("tcrn-r46-i16-subtasks-");
  const [, second, third] = fixture.targets;
  const create = async (externalKey, kind, extra) => (await cli(["work-create", "--workspace", fixture.workspace, "--project-id", fixture.projectId, "--at", nextAt(), "--external-key", externalKey, "--kind", kind, ...extra], fixture.atelier)).record;
  const initiative = await create("R46-I16-INIT", "Initiative", ["--title", "Initiative with subtasks", "--involved-projects", JSON.stringify({ state: "selected", targets: [second, third] })]);
  const epic = await create("R46-I16-EPIC", "Epic", ["--parent-id", initiative.id, "--title", "Epic with subtasks"]);
  const story = await create("R46-I16-STORY", "Story", ["--parent-id", epic.id, "--title", "Story with subtasks", "--goal", "The second project changes.", "--acceptance", "Given the second project When worked Then it changes.", "--involved-projects", JSON.stringify({ state: "selected", targets: [second] })]);
  const first = await create("R46-I16-SUB-A", "Subtask", ["--parent-id", story.id, "--title", "Second project's subtask", "--involved-projects", JSON.stringify({ state: "selected", targets: [second] })]);
  const other = await create("R46-I16-SUB-B", "Subtask", ["--parent-id", story.id, "--title", "Coordinating subtask", "--involved-projects", JSON.stringify({ state: "coordination-only", targets: [] })]);
  const locales = await localeTable();
  const page = await loadExecutedDom(fixture);
  try {
    const { document, window } = page;
    await openWorkEditor(page);
    const content = document.querySelector("#work-tree-content");
    const storyRow = content.querySelector(`[data-work-id="${story.id}"]`);
    assert.ok(storyRow);
    const group = content.querySelector(`[data-work-subtasks="${story.id}"]`);
    assert.ok(group, "the Story's Subtasks are listed under it");
    assert.equal(group.getAttribute("role"), "group");
    assert.equal(storyRow.getAttribute("aria-owns"), group.id, "the Story owns its Subtasks in the tree");
    const rows = [...group.querySelectorAll('[role="treeitem"]')];
    assert.deepEqual(rows.map((row) => row.dataset.workId), [first.id, other.id]);
    for (const row of rows) {
      assert.deepEqual(["tcrn-record-row", "tcrn-record-row--dense"].filter((name) => row.classList.contains(name)), ["tcrn-record-row", "tcrn-record-row--dense"], "built as the Story row is");
      assert.equal(row.dataset.workKind, "Subtask");
    }
    assert.equal(rows[0].querySelector("[data-work-involved]").textContent, `${locales.en["projects.title"]}: TCRN-INC148-DOM-SECOND`);
    assert.equal(rows[1].querySelector("[data-work-involved]").textContent, `${locales.en["projects.title"]}: ${locales.en["projects.coordination-only"]}`);
    assert.equal(storyRow.querySelector("[data-work-involved]").textContent, `${locales.en["projects.title"]}: TCRN-INC148-DOM-SECOND`);
    // Filtering by the second project keeps the Subtask and its parents, and drops what involves only others.
    const filter = document.querySelector("#work-target-editor [data-target-filter]");
    filter.value = JSON.stringify({ libraryId: second.libraryId, projectId: second.projectId });
    filter.dispatchEvent(new window.Event("change", { bubbles: true }));
    await waitFor(() => document.querySelector(`#work-tree-content [data-work-subtasks="${story.id}"]`), "the filtered tree");
    assert.ok(document.querySelector(`#work-tree-content [data-work-id="${first.id}"]`), "the matching Subtask stays");
    assert.equal(document.querySelector(`#work-tree-content [data-work-id="${other.id}"]`), null, "a Subtask involving no matching project leaves");
    assert.ok(document.querySelector(`#work-tree-content [data-work-id="${initiative.id}"]`), "its parents stay");
    document.querySelector('[data-locale-option="ko"]')?.click();
    await waitFor(() => document.querySelector(`#work-tree-content [data-work-id="${first.id}"] [data-work-involved]`)?.textContent === `${locales.ko["projects.title"]}: TCRN-INC148-DOM-SECOND`, "ko: the involved projects in the page's language");
  } finally { await closePage(page, fixture); }
});


if (!MUTATION) test("R45 U12: a saved relation is read back through the work view's one read, which drops a library the page has left and shows a failed read", async () => {
  const fixture = await projectChainFixture("tcrn-r45-u12-dom-");
  const first = await cli(["work-create", "--workspace", fixture.workspace, "--project-id", fixture.projectId, "--at", nextAt(), "--external-key", "R45-U12-FIRST", "--kind", "Initiative", "--title", "First library work"], fixture.atelier);
  const second = await cli(["work-create", "--workspace", fixture.second.library, "--project-id", fixture.second.projectId, "--at", nextAt(), "--external-key", "R45-U12-SECOND", "--kind", "Initiative", "--title", "Second library work"], fixture.atelier);
  const page = await loadExecutedDom(fixture);
  try {
    const { document } = page;
    const content = document.querySelector("#work-tree-content");
    let editor = await openWorkEditor(page);
    await page.waitForSettled();
    assert.ok(content.querySelector(`[data-work-id="${first.record.id}"]`), "the first library's work is listed");
    const source = await readFile(join(portalRoot, "index.html"), "utf8");
    assert.equal(source.split('api("/api/work")').length - 1, 1, "the save path has no read of its own");

    // The save's read of /api/work is held; the reader switches to the second library; the held read
    // then fails. Its answer belongs to a library the page has left, so the view shows the second
    // library's work and no failure.
    // The receipt names the record a save wrote; two libraries can reach the same version number.
    const receiptNames = (id) => () => document.querySelector("#operation-feedback")?.textContent.includes(id);
    let workReads = 0;
    page.hold((path) => path === "/api/work" && (workReads += 1) === 1);
    editor.querySelector("[data-target-state]").value = "coordination-only";
    editor.querySelector("[data-target-save]").click();
    await waitFor(receiptNames(first.record.id), "the save receipt");
    await waitFor(() => page.held() === 1, "the save's read of /api/work");
    const select = document.querySelector("#library-select");
    select.value = fixture.second.project;
    select.dispatchEvent(new page.window.Event("change", { bubbles: true }));
    await waitFor(() => content.querySelector(`[data-work-id="${second.record.id}"]`), "the second library's work");
    assert.equal(page.release({ error: new TypeError("fetch failed") }), 1);
    await page.waitForSettled();
    assert.equal(content.querySelector("[data-work-failure]"), null, "the left library's failed read is dropped");
    assert.ok(content.querySelector(`[data-work-id="${second.record.id}"]`), "the view keeps the second library's work");
    assert.equal(content.querySelector(`[data-work-id="${first.record.id}"]`), null);

    // On the second library, a save whose read fails shows the failure in the work view, and the
    // save's own receipt stays the receipt.
    editor = await openWorkEditor(page);
    await waitFor(() => editor.querySelector("[data-target-work] option")?.value === second.record.id, "the second library's editor");
    await page.waitForSettled();
    editor.querySelector("[data-target-state]").value = "coordination-only";
    page.hold((path) => path === "/api/work");
    editor.querySelector("[data-target-save]").click();
    await waitFor(receiptNames(second.record.id), "the second save receipt");
    const savedReceipt = receiptText(document);
    await waitFor(() => page.held() === 1, "the second save's read of /api/work");
    assert.equal(page.release({ error: new TypeError("fetch failed") }), 1);
    await page.waitForSettled();
    const failure = content.querySelector("[data-work-failure]");
    assert.equal(failure?.dataset.workFailure, "PORTAL_READ_FAILED", "a failed read is shown in the work view");
    assert.equal(failure.getAttribute("role"), "alert");
    assert.equal(receiptText(document), savedReceipt, "the receipt is still the save's");
    assert.ok(receiptNames(second.record.id)(), "and still names the record the save wrote");
  } finally { await closePage(page, fixture); }
});


// TCRN-CROSS-STORY-528 (MIN-256; TCRN-CROSS-SUB-459): the work tree names each leased item's holder and
// when the lease runs out, on the item's own row or group head, beside a DS button that releases it by
// force; a released lease leaves the row, and work-show reads no lease. The portal runs with an
// explicit TCRN_PORTAL_ACTOR.
if (!MUTATION) test("528 SUB-459: the work tree shows a lease with its holder and expiry, and its button releases it by force", async () => {
  const fixture = await scratch("tcrn-528-lease-");
  const holder = "agent:alpha";
  const create = async (externalKey, kind, extra) => (await cli(["work-create", "--workspace", fixture.workspace, "--project-id", fixture.projectId, "--at", nextAt(), "--external-key", externalKey, "--kind", kind, ...extra], fixture.deviceEnv)).record;
  const initiative = await create("LEASE-UI-INIT", "Initiative", ["--title", "Leased initiative"]);
  const epic = await create("LEASE-UI-EPIC", "Epic", ["--parent-id", initiative.id, "--title", "Leased epic"]);
  const story = await create("LEASE-UI-STORY", "Story", ["--parent-id", epic.id, "--title", "Leased story", "--goal", "One writer at a time.", "--acceptance", "Given a lease When another actor writes Then it is refused."]);
  // The page judges whether a lease runs by the clock, so the claims are taken at this moment.
  const claimedAt = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString().replace(".000Z", "Z");
  const expiresAt = new Date(Date.parse(claimedAt) + 2 * 3_600_000).toISOString().replace(".000Z", "Z");
  for (const id of [story.id, epic.id]) await cli(["work-claim", "--workspace", fixture.workspace, "--at", claimedAt, "--id", id, "--actor", holder], fixture.deviceEnv);
  const locales = await localeTable();
  const page = await loadExecutedDom(fixture, { TCRN_PORTAL_ACTOR: "agent:test-portal" });
  try {
    const { document } = page;
    await openWorkEditor(page);
    const held = locales.en["dashboard.leaseHeld"].replace("{holder}", holder).replace("{expiresAt}", expiresAt);
    const storyRow = await waitFor(() => document.querySelector(`#work-tree-content [data-work-id="${story.id}"]`), "the leased Story's row");
    const lease = storyRow.querySelector("[data-work-lease]");
    assert.equal(lease?.dataset.workLease, "active");
    assert.equal(lease.textContent, held, "the row names the holder and when the lease runs out");
    const button = storyRow.querySelector(`[data-work-lease-release="${story.id}"]`);
    assert.equal(button?.getAttribute("type"), "button");
    assert.deepEqual([...button.classList], ["tcrn-button", "tcrn-button--secondary", "tcrn-button--sm"], "the release is the published DS button");
    assert.equal(button.textContent, locales.en["dashboard.leaseRelease"]);
    const epicHead = document.querySelector(`#work-tree-content [data-work-id="${epic.id}"] > summary`);
    assert.equal(epicHead.querySelector("[data-work-lease]")?.textContent, held, "an Epic's lease shows on its group head");
    assert.equal(document.querySelector(`#work-tree-content [data-work-id="${initiative.id}"] > summary [data-work-lease]`), null, "an item without a lease shows none");

    button.click();
    await waitFor(() => {
      const row = document.querySelector(`#work-tree-content [data-work-id="${story.id}"]`);
      return row !== null && row.querySelector("[data-work-lease]") === null ? row : null;
    }, "the Story's row without its lease");
    assert.equal((await cli(["work-show", "--workspace", fixture.workspace, "--id", story.id], fixture.deviceEnv)).lease, null, "work-show reads no lease after the forced release");
    assert.equal(document.querySelector(`#work-tree-content [data-work-id="${epic.id}"] > summary [data-work-lease]`)?.textContent, held, "the Epic keeps its own lease");
  } finally { await closePage(page, fixture); }
});


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
