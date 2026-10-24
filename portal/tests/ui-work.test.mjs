// SPDX-License-Identifier: Apache-2.0
import { canonicalDocumentBytes } from "../../scripts/lib/canonical-json.mjs";
// Tests in this file run sequentially; Node isolates each file in a process.
import { CLI, MUTATION, assert, cli, closePage, join, loadExecutedDom, localeTable, nextAt, openWorkContentEditor, openWorkEditor, portalRoot, preparePage, projectChainFixture, readFile, receiptAdvanced, receiptText, rm, scopedWorkFixture, scratch, test, waitFor, writeFile } from "./ui-presence-support.mjs";



// TCRN-CROSS-INIT-053 R46 (I09; I04, U20 D5): a library whose knowledge store was never created shows the
// published EmptyState that says so, with the status filter in place, rather than a failed read; once
// the library has a store the view is the ordinary one.
if (!MUTATION) test("R46 I09: a library without a knowledge store shows an empty inventory, and a created store does not", async () => {
  const page = await preparePage();
  try {
    const { document, window } = page;
    const locales = await localeTable();
    document.querySelector('[data-page-target="dashboard"]')?.click();
    document.querySelector('[data-workspace-tab="knowledge"]')?.click();
    const content = document.querySelector("#knowledge-view-content");
    const empty = content.querySelector('[data-knowledge-store="absent"]');
    assert.ok(empty, "the empty inventory is shown");
    assert.equal(empty.tagName, "SECTION");
    assert.deepEqual(["tcrn-state-surface", "tcrn-state-surface--neutral"].filter((name) => empty.classList.contains(name)), ["tcrn-state-surface", "tcrn-state-surface--neutral"]);
    assert.equal(empty.dataset.stateSurfaceKind, "empty");
    assert.equal(empty.querySelector("h3.tcrn-heading.tcrn-state-surface__title").textContent, locales.en["knowledge.storeAbsentTitle"]);
    assert.equal(empty.querySelector("p.tcrn-text.tcrn-state-surface__description").textContent, locales.en["knowledge.storeAbsentBody"]);
    assert.equal(content.textContent.includes(locales.en["config.readUnavailable"]), false, "not a failed read");
    assert.ok(content.querySelector('[data-ui="knowledge-status-filter"]'), "the status filter stays");
    document.querySelector('[data-locale-option="ja"]')?.click();
    assert.equal(document.querySelector('#knowledge-view-content [data-knowledge-store="absent"] .tcrn-state-surface__title').textContent, locales.ja["knowledge.storeAbsentTitle"]);
    document.querySelector('[data-locale-option="en"]')?.click();
    await cli(["knowledge-init", "--workspace", page.workspace, "--acknowledge-disposable", "true"], page.deviceEnv);
    const status = document.querySelector('[data-ui="knowledge-status-filter"]');
    status.value = "all";
    status.dispatchEvent(new window.Event("change", { bubbles: true }));
    await waitFor(() => document.querySelector('#knowledge-view-content [data-ui="knowledge-status-filter"]')?.value === "all" && document.querySelector("#knowledge-view-content [data-knowledge-store]") === null, "the view of the created store");
    assert.equal(document.querySelector("#knowledge-view-content .tcrn-state-surface").textContent, locales.en["dashboard.knowledgeEmpty"]);
  } finally { await page.cleanup(); }
});

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

if (!MUTATION) test("INIT068: typed drafts keep free body edits across type changes, repeated requests, disclosure close and navigation", async () => {
  const page = await preparePage();
  try {
    const { document, window } = page;
    await openWorkContentEditor(page);
    const control = name => document.querySelector(`#work-content-editor [data-content-${name}]`);
    const change = (node, value, event = "change") => { node.value = value; node.dispatchEvent(new window.Event(event, { bubbles: true })); };
    control("draft").click();
    await waitFor(() => document.querySelector('[data-content-field="body"]'), "typed draft body");
    const body = () => document.querySelector('[data-content-field="body"]');
    change(body(), "Free body without imposed headings 🧭 \"quoted\" &quot; </textarea><b>literal</b>", "input");
    assert.deepEqual([...document.querySelectorAll("#work-content-editor [data-content-group]")].map(node => node.dataset.contentGroup), ["goal", "sources", "scope", "requirements", "completion"]);
    assert.equal(document.querySelector('[data-content-field="completion"]').value, "");
    control("draft").click();
    assert.equal(body().value, "Free body without imposed headings 🧭 \"quoted\" &quot; </textarea><b>literal</b>", "repeated draft cannot reset edits");
    change(control("kind"), "Epic"); control("draft").click();
    await waitFor(() => document.querySelector('[data-content-field="details"]')?.value.includes("childResponsibilities"), "Epic responsibilities");
    change(control("kind"), "Story"); control("draft").click();
    assert.equal(body().value, "Free body without imposed headings 🧭 \"quoted\" &quot; </textarea><b>literal</b>");
    const disclosure = document.querySelector("#work-content-editor details"); disclosure.open = false;
    document.querySelector('[data-page-target="settings"]').click();
    document.querySelector('[data-page-target="dashboard"]').click();
    assert.equal(body().value, "Free body without imposed headings 🧭 \"quoted\" &quot; </textarea><b>literal</b>");
    change(document.querySelector('[data-content-field="sources"]'), "{\"unfinished\": \"&quot;", "input");
    control("save").click();
    await waitFor(() => control("error"), "parse error is visible");
    assert.equal(document.querySelector('[data-content-field="sources"]').value, "{\"unfinished\": \"&quot;", "failed save retains invalid input for repair");
    assert.equal(body().value, "Free body without imposed headings 🧭 \"quoted\" &quot; </textarea><b>literal</b>");
    control("undo").click();
    assert.equal(body().value, "");
    change(control("variant"), "defect"); control("draft").click();
    await waitFor(() => document.querySelector('[data-content-field="details"]')?.value.includes("reproduction"), "defect responsibilities");
    for (const field of ["expected", "actual", "reproduction", "affectedVersion", "fixBoundary", "regression"]) assert.ok(JSON.parse(document.querySelector('[data-content-field="details"]').value)[field] === "");
  } finally { await page.cleanup(); }
});

if (!MUTATION) test("INIT068: segmented mixed legacy scope and explicit fields survive direct and inherited DOM delivery", async () => {
  const fixture = await scratch("init068-mixed-scope-ui-");
  let page;
  try {
    const create = async (key, kind, extra) => (await cli(["work-create", "--workspace", fixture.workspace, "--project-id", fixture.projectId, "--at", nextAt(), "--external-key", key, "--kind", kind, "--title", key, ...extra], fixture.deviceEnv)).record;
    const scope = "Preserve independently inherited constraints. 🧭\n".repeat(400) + "KEEP-RESERVED-BACKUP";
    const parent = await create("MIXED-SCOPE-INIT", "Initiative", ["--goal", "Explicit goal", "--acceptance", "Explicit acceptance", "--body", "Explicit body", "--scope", scope]);
    const child = await create("MIXED-SCOPE-EPIC", "Epic", ["--parent-id", parent.id, "--goal", "Child goal", "--body", "Child body"]);
    page = await loadExecutedDom(fixture);
    await openWorkContentEditor(page);
    for (const record of [child, parent]) {
      const expected = (await cli(["work-show", "--workspace", fixture.workspace, "--id", record.id], fixture.deviceEnv)).workContent;
      const select = page.document.querySelector("[data-content-work]");
      select.value = record.id; select.dispatchEvent(new page.window.Event("change", { bubbles: true }));
      await waitFor(() => page.document.querySelector("[data-content-more]"), "explicit partial content state");
      assert.equal(page.document.querySelector("[data-content-legacy]"), null, "a partial JSON document is not presented as complete legacy content");
      while (page.document.querySelector("[data-content-more]")) {
        const before = page.document.querySelector("[data-content-delivery]").textContent;
        page.document.querySelector("[data-content-more]").click();
        await page.waitForSettled();
        assert.equal(page.document.querySelector("[data-content-error]"), null);
        assert.notEqual(page.document.querySelector("[data-content-delivery]").textContent, before, "each segment advances delivery");
      }
      await waitFor(() => page.document.querySelector("[data-content-legacy]"), "complete mixed legacy content");
      for (const row of expected.records) {
        const rendered = page.document.querySelector(`[data-content-source="${row.workId}"] pre`);
        assert.ok(rendered, row.externalKey);
        assert.deepEqual(JSON.parse(rendered.textContent), row, "the complete canonical row, including scope, reaches the DOM");
      }
      assert.ok(page.document.querySelector("#work-content-editor").textContent.includes("KEEP-RESERVED-BACKUP"));
      assert.equal(expected.records.find(row => row.workId === parent.id).scope, scope);
    }
  } finally { if (page) await closePage(page, fixture); else await rm(fixture.base, { recursive: true, force: true }); }
});

// MIN376 R15/R16 v2: this requires a genuinely delivered, distinguishable capable V,
// verified writer/barrier evidence and supported v2 enablement. The current same-version
// candidate cannot establish it. Keep the real default/no-manual-receipt scenario pending,
// rather than relabeling a synthetic policy or explicit receipt as enabled-default proof.
if (!MUTATION) test.todo("INIT068: real capable-V project enablement saves its admitted default without receipt JSON (pending actual V/build, writer inventory, barrier and accepted-boundary evidence)");

if (!MUTATION) test("INIT068: unenabled draft shows canonical not-ready evidence; explicit admitted receipt save, undo and stale-save remain independent", async () => {
  const fixture = await scratch("init068-explicit-save-ui-");
  let page;
  try {
    const draft = await cli(["work-draft", "--workspace", fixture.workspace, "--project-id", fixture.projectId, "--kind", "Initiative"], fixture.deviceEnv);
    const templatePath = join(fixture.base, "Initiative.json");
    await writeFile(templatePath, canonicalDocumentBytes(draft.contentTemplate));
    const admitted = await cli(["template-admit", "--workspace", fixture.workspace, "--at", nextAt(), "--template", templatePath, "--owner", "owner:fixture"], fixture.deviceEnv);
    page = await loadExecutedDom(fixture);
    await openWorkContentEditor(page);
    const control = name => page.document.querySelector(`[data-content-${name}]`);
    const field = name => page.document.querySelector(`[data-content-field="${name}"]`);
    const change = (node, value, event = "input") => { node.value = value; node.dispatchEvent(new page.window.Event(event, { bubbles: true })); };
    change(control("kind"), "Initiative", "change"); control("draft").click();
    await waitFor(() => field("body"), "new unenabled draft");
    assert.equal(control("advanced-receipt").hasAttribute("open"), false, "the existing receipt escape hatch is not the ordinary authoring flow");
    assert.equal(page.document.querySelector('[data-content-meta="templateReceipt"]').value, "");
    change(page.document.querySelector('[data-content-meta="externalKey"]'), "INIT068-UI-SAVED");
    change(page.document.querySelector('[data-content-meta="title"]'), "Explicit-admission UI draft");
    change(field("body"), "Saved free body");
    const readinessView = JSON.parse(page.document.querySelector("#work-content-editor [data-content-missing]").textContent).contentRolloutReadiness;
    const currentDraft = await cli(["work-draft", "--workspace", fixture.workspace, "--project-id", fixture.projectId, "--kind", "Initiative"], fixture.deviceEnv);
    assert.deepEqual(readinessView, currentDraft.contentRolloutReadiness);
    assert.equal(readinessView.ready, false);
    assert.ok(readinessView.problems.includes("CAPABLE_DELIVERY_UNVERIFIED"));
    control("save").click();
    await waitFor(() => control("error"), "no implicit enablement or unbound typed write");
    assert.ok(control("error").textContent.includes("WORK_CONTENT_TEMPLATE_REQUIRED"));
    assert.equal(field("body").value, "Saved free body", "refusal keeps the authoring draft");
    control("advanced-receipt").open = true;
    change(page.document.querySelector('[data-content-meta="templateReceipt"]'), JSON.stringify(admitted.receipt));
    control("save").click();
    await waitFor(() => control("reload") && field("body"), "explicit-admission canonical readback (not policy enablement)");
    assert.equal(control("error"), null);
    const shown = await cli(["work-show", "--workspace", fixture.workspace, "--external-key", "INIT068-UI-SAVED"], fixture.deviceEnv);
    assert.equal(shown.content.body, "Saved free body");
    assert.equal(field("body").value, shown.content.body);
    change(field("body"), "Unsaved local edit"); control("undo").click();
    assert.equal(field("body").value, shown.content.body);
    const remote = { ...shown.content, body: "Concurrent canonical edit" };
    await cli(["work-annotate", "--workspace", fixture.workspace, "--at", nextAt(), "--id", shown.record.id, "--expected-revision", String(shown.record.revision), "--content", JSON.stringify(remote)], fixture.deviceEnv);
    change(field("body"), "Keep this rejected local edit"); control("save").click();
    await waitFor(() => control("error"), "visible stale revision refusal");
    assert.ok(control("error").textContent.includes("work revision changed"));
    assert.equal(field("body").value, "Keep this rejected local edit");
    assert.deepEqual((await cli(["work-show", "--workspace", fixture.workspace, "--id", shown.record.id], fixture.deviceEnv)).content, remote);
    control("reload").click();
    await waitFor(() => field("body")?.value === remote.body, "explicit reload of concurrent canonical content");
  } finally { if (page) await closePage(page, fixture); else await rm(fixture.base, { recursive: true, force: true }); }
});
