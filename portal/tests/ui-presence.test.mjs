// SPDX-License-Identifier: Apache-2.0
// Tests in this file run sequentially; Node isolates each file in a process.
import { CLI, DS_CONTRACT, GHOST_TARGET, MUTATION, assert, assertBehaviorContract, assertDomContract, bridgeExports, cli, closePage, join, keydown, linkBridge, loadExecutedDom, localeTable, nextAt, policySwitchControls, preparePage, projectChainFixture, readFile, receiptAdvanced, receiptText, rm, scratch, seed, test, vm, waitFor, writeFile, writeScratch } from './ui-presence-support.mjs';
if (MUTATION) {
  test(`INC-148 meta-criterion mutation ${MUTATION} must red`, async () => {
    const page = await preparePage();
    try {
      if (MUTATION === "presentation") {
        const target = page.document.querySelector('[data-ui="workspace-tabs"]');
        const replacement = page.document.createElement("div");
        replacement.setAttribute("role", "presentation");
        target.replaceWith(replacement);
      }
      assertDomContract(page.document);
      await assertBehaviorContract(page);
    } finally {
      await page.cleanup();
    }
  });
}
if (!MUTATION) {
  test("INC-148 rendered DOM contract names every preview component", async () => {
    const page = await preparePage();
    try { assertDomContract(page.document); } finally { await page.cleanup(); }
  });
}
if (!MUTATION) {

  test("INC-148 rendered DOM behavior changes receipt state", async () => {
    const page = await preparePage();
    try {
      assertDomContract(page.document);
      await assertBehaviorContract(page);
      const complete = JSON.parse(page.document.querySelector("#receipt-raw").textContent);
      assert.equal(typeof complete.reasonCode, "string", "the complete result remains available inside the disclosed receipt");
      assert.ok(page.document.querySelector("#receipt-raw").closest("#receipt-details"), "technical JSON uses the existing on-demand details boundary");
    } finally { await page.cleanup(); }
  });
}
if (!MUTATION) {

  test("INC-221 a settle signal that never arrives fails by name, not by silent misread", async () => {
    // The property that makes waiting safer than sleeping: a sleep that is too short
    // reports a wrong value as if it were the truth, while a wait that never settles says
    // what it was waiting for. loadExecutedDom now depends on this, so it is pinned here.
    await assert.rejects(
      () => waitFor(() => false, "a signal that cannot arrive", 60),
      (error) => /timed out after 60ms waiting for a signal that cannot arrive/u.test(String(error?.message)),
    );
    // And it returns the predicate's value the moment it is truthy, so a settled page
    // costs one poll interval rather than a fixed budget.
    assert.equal(await waitFor(() => "settled", "an immediate signal"), "settled");
  });
}
if (!MUTATION) {

  test("INC-151 rendered engine card follows the engine status value", async () => {
    const fixture = await scratch("tcrn-inc151-engine-dom-");
    const wrapper = join(fixture.base, "engine-version-wrapper.mjs");
    await writeFile(wrapper, `import { spawnSync } from "node:child_process";
const actual = spawnSync(process.execPath, [${JSON.stringify(CLI)}, ...process.argv.slice(2)], { encoding: "utf8" });
if (process.argv[2] === "status" && actual.status === 0) {
  const body = JSON.parse(actual.stdout);
  body.engineVersion = "0.11.99";
  process.stdout.write(JSON.stringify(body));
} else {
  process.stdout.write(actual.stdout || "");
  process.stderr.write(actual.stderr || "");
  process.exitCode = actual.status ?? 1;
}
`, "utf8");
    const page = await loadExecutedDom(fixture, { TCRN_WORKFLOW_CLI: wrapper });
    try { assert.equal(page.document.querySelector("#stat-engine").textContent, "0.11.99"); } finally { page.child.kill(); await rm(fixture.base, { recursive: true, force: true }); }
  });
}
if (!MUTATION) {

  test("INC-150 vocabulary descriptions are localized in the executed DOM", async () => {
    const page = await preparePage();
    try {
      // INC-167: language is chosen from the design system's locale menu, so the test
      // drives the option the way a reader does rather than setting a select's value.
      page.document.querySelector('[data-locale-option="zh-CN"]').dispatchEvent(new page.window.Event("click", { bubbles: true }));
      // INC-176: the vocabulary is a table now, so the localized description lives in
      // the Description cell of the first row rather than a definition list.
      // linkedom has no :nth-child, and the cell carries its column name in data-label
      // anyway — which is the more honest anchor: it names the column, not a position.
      const definition = [...page.document.querySelectorAll('[data-vocabulary-table] .tcrn-table-shell__cell')].find((cell) => cell.getAttribute("data-label") === "描述")?.textContent || "";
      assert.match(definition, /确定方向与预期成果|审视结构与技术选择|揭示威胁、缓解措施与暴露面/u);
      assert.doesNotMatch(definition, /Sets direction and intended outcomes|Examines structural and technical choices|Surfaces threats, mitigations, and exposure/u);
      assert.equal(page.document.querySelector('[data-i18n="dashboard.chain"]')?.textContent, "合并版本");
      assert.ok([...page.document.querySelectorAll("[data-i18n]")].every((node) => node.textContent.trim().length > 0), "every static i18n binding must render text in the executed DOM");
    } finally { await page.cleanup(); }
  });
}
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
if (!MUTATION) {

  test("INC-193 the design authority is declared, and what cannot be checked here is yellow", async () => {
    const page = await preparePage();
    try {
      page.document.querySelector('[data-setting-group="general"]')?.click();
      await new Promise((resolve) => setTimeout(resolve, 80));
      const row = page.document.querySelector('[data-setting-row="design.authority"]');
      assert.ok(row, "the design authority is a setting of the general group");
      assert.ok(row.querySelector('[data-concept-tip="setting.design.authority"]'), "its ceiling is explained where it is set");

      // Unset is the ordinary case for a workspace with no design system, and it is
      // silent: no panel, no warning, nothing to resolve. A gate that could not be
      // satisfied in this world would make the optional key effectively required.
      const panel = page.document.querySelector("#design-authority");
      assert.ok(panel, "the panel exists even when there is nothing to show");
      assert.equal(panel.hidden, true, "an undeclared optional design authority needs no warning");
      assert.equal(panel.querySelector("[data-design-authority-state]"), null);

      // The contract is fetched by the reader's browser. Both outcomes are exercised
      // here because only one of them can be produced against a real address offline,
      // and a state proven on one side only is half a state machine.
      const realFetch = page.window.fetch;
      // TCRN-CROSS-INC-221. The stub records when it answered, because the panel is the
      // only other observable and two of the three cases below render byte-identically —
      // deliberately, since a body under a foreign contract must leak nothing. There is no
      // change to wait for, so the settle signal is the contract fetch being answered plus
      // a quiet period for the handler to render it.
      const traffic = { answered: 0, at: 0 };
      const answerWith = (body, ok = true) => {
        page.window.fetch = (input, options) => {
          const target = String(input);
          if (!target.includes("tcrn-design-authority.json")) return realFetch(input, options);
          traffic.answered += 1;
          traffic.at = Date.now();
          return Promise.resolve({ ok, status: ok ? 200 : 404, json: async () => body });
        };
      };
      const rendered = (label) => {
        const seen = traffic.answered;
        return async () => {
          await waitFor(() => traffic.answered > seen && Date.now() - traffic.at >= 120, label);
        };
      };

      for (const [key, value] of Object.entries({"design.repository":"https://design.example.test/repository","design.pullRequestTarget":"main","design.productionDocs":"https://design.example.test/docs","design.buildService":"Example build","design.buildProject":"Example docs","design.consumedVersion":"9.9.9"})) {
        await writeScratch(page.fixture, "settings-set", ["--key", key, "--value", value]);
      }
      answerWith({ schemaVersion: "tcrn.design-authority.v1", name: "Example System", version: "9.9.9" });
      let input = page.document.querySelector('[data-setting-control="design.authority"]');
      const declaredRendered = rendered("the declared contract to be fetched and rendered");
      input.value = "https://design.example.test/";
      input.dispatchEvent(new page.window.Event("change", { bubbles: true }));
      await declaredRendered();
      await page.waitForSettled();
      const declared = page.document.querySelector("[data-design-authority-state]");
      assert.equal(declared?.dataset.designAuthorityState, "declared");
      assert.match(declared.textContent, /Example System/u);
      assert.match(declared.textContent, /9\.9\.9/u);
      assert.ok(!declared.className.includes("--warning"), "a contract that answered is not a warning");

      // A response that is not this platform's contract is yellow, not red: the fact is
      // outside this machine, so nothing here can be called false. The message has to
      // say what would turn it green, or a yellow becomes a permanent decoration.
      answerWith({ hello: "world" });
      const warnedRendered = rendered("the foreign response to be fetched and rendered");
      input = page.document.querySelector('[data-setting-control="design.authority"]');
      input.value = "https://other.example.test/";
      input.dispatchEvent(new page.window.Event("change", { bubbles: true }));
      await warnedRendered();
      await page.waitForSettled();
      const warned = page.document.querySelector("[data-design-authority-state]");
      assert.equal(warned?.dataset.designAuthorityState, "warning", "a response that is not this contract is yellow");
      assert.ok(warned.className.includes("tcrn-inline-alert"), "the warning uses the design system's alert");
      assert.ok(warned.className.includes("tcrn-inline-alert--warning"));
      assert.match(warned.textContent, /advisory|unknown/u, "a browser check cannot claim production publication");

      // A body that is well-formed in every way EXCEPT the schema version isolates that
      // check. Without this case the schema check could be deleted and nothing would
      // notice, because the earlier sample was also missing its name and version and
      // would keep landing yellow by a different route.
      answerWith({ schemaVersion: "someone.elses.contract.v1", name: "Example System", version: "9.9.9" });
      const wrongSchemaRendered = rendered("the body under another contract to be fetched and rendered");
      input = page.document.querySelector('[data-setting-control="design.authority"]');
      input.value = "https://third.example.test/";
      input.dispatchEvent(new page.window.Event("change", { bubbles: true }));
      await wrongSchemaRendered();
      await page.waitForSettled();
      const wrongSchema = page.document.querySelector("[data-design-authority-state]");
      assert.equal(wrongSchema?.dataset.designAuthorityState, "warning", "a well-formed body under another contract is still not ours");
      assert.ok(!wrongSchema.textContent.includes("Example System"), "nothing from an unrecognised contract reaches the page");
    } finally { await page.cleanup(); }
  });
}
if (!MUTATION) {

  test("INC-192 abstract concepts carry a supplemental explanation the keyboard can reach", async () => {
    const page = await preparePage();
    try {
      page.document.querySelector('[data-setting-group="general"]')?.click();
      await new Promise((resolve) => setTimeout(resolve, 80));
      const tip = page.document.querySelector('[data-concept-tip="setting.design.authority"]');
      assert.ok(tip, "the design authority declaration carries its supplemental explanation");

      // This long explanation uses the design system's non-interactive Popover boundary:
      // the consumer supplies the trigger and domain copy, while the mounted layer is
      // body-bound and cannot be clipped by a settings row.
      assert.equal(tip.getAttribute("data-overlay-scope"), "popover");
      assert.equal(tip.getAttribute("data-static-overlay-kind"), "popover");
      const trigger = tip.querySelector("button");
      const layerId = trigger?.getAttribute("aria-controls");
      const content = layerId ? page.document.getElementById(layerId) : null;
      assert.ok(trigger && content);
      assert.equal(trigger.getAttribute("aria-haspopup"), "dialog");
      assert.equal(trigger.getAttribute("aria-controls"), content.getAttribute("id"));
      assert.equal(content.getAttribute("role"), "dialog");
      assert.equal(content.parentElement, page.document.body, "the popover layer must be mounted at document body");
      assert.equal(content.getAttribute("data-overlay-boundary"), "document-body");
      assert.equal(content.getAttribute("data-overlay-positioning"), "static-fixed");
      assert.equal(content.getAttribute("data-ds-overlay-candidate"), `TCRN-Design-System@${DS_CONTRACT.candidate}`);
      assert.equal(content.hidden, true, "a mounted popover starts closed");
      // INC-201: the contract is that the trigger names *a* design-system button
      // component, which is what design-proof's button-family leg enforces. It used to
      // be pinned to tcrn-icon-button specifically, and that class is a 38x38 control
      // box — carrying it and then overriding its every declaration is the collision
      // INC-196 was about, so the 16px info affordance names tcrn-button instead.
      assert.ok(
        ["tcrn-button", "tcrn-icon-button", "tcrn-link-button"].some((name) => trigger.classList.contains(name)),
        "the trigger names a design-system button component",
      );
      assert.ok(trigger.querySelector("svg"), "the icon is inline SVG, not a character the shipped font may not have");
      assert.equal(trigger.textContent.trim(), "", "no glyph stands in for the icon");
      assert.equal(content.querySelectorAll("a,button,input,select,textarea").length, 0, "the design system forbids interactive content inside a tooltip");

      trigger.dispatchEvent(new page.window.Event("click", { bubbles: true }));
      assert.equal(content.hidden, false, "the popover opens from its trigger");
      assert.equal(trigger.getAttribute("aria-expanded"), "true");
      const escape = new page.window.Event("keydown", { bubbles: true });
      Object.defineProperty(escape, "key", { value: "Escape" });
      page.document.dispatchEvent(escape);
      assert.equal(content.hidden, true, "Escape closes the popover");
      assert.equal(trigger.getAttribute("aria-expanded"), "false");

      // The explanation says the thing the surface does not — here, that the engine
      // never checks the declaration is true. A tip that only repeated the label would
      // train the icon into noise.
      assert.ok(content.textContent.trim().length > 0 && !content.textContent.startsWith("concept."));
      assert.ok(!content.textContent.startsWith("concept."), "a tip must not show the reader its own key");

      // Every dictionary category carries one; they had no explanation at all before.
      page.document.querySelector('[data-page-target="vocabulary"]')?.click();
      await new Promise((resolve) => setTimeout(resolve, 80));
      const categories = [...page.document.querySelectorAll("[data-vocabulary-category]")]
        .map((button) => button.dataset.vocabularyCategory)
        .filter((category) => !category.startsWith("setting:"));
      const explained = [...page.document.querySelectorAll('#vocabulary-nav [data-concept-tip]')]
        .map((node) => node.dataset.conceptTip.replace("vocabulary.", ""));
      assert.deepEqual(explained.slice().sort(), categories.slice().sort(), "every dictionary category is explained");
    } finally { await page.cleanup(); }
  });
}


// TCRN-CROSS-INIT-053 R46 (I09; I03, PP-2): a saved common default that no registered library answers no
// longer refuses the target's settings. The settings read; every key that would inherit from it has no
// value, says so and offers no default in its place; the bindings list the saved choice first as
// unavailable, say why, and stop the inheritance from the page, after which the target reads plainly.
if (!MUTATION) test("R46 S19: the harness reads the export clause of a static bridge as data", () => {
  // A synthetic bridge with three exports, locals a minifier could name, and a notice after the clause.
  const source = "const $a=1;function _$b(){return 2}const c$$=3;export{$a as first,_$b as second,c$$};\n/*! notice: export is a word here too */\n";
  const { clause, bindings } = bridgeExports(source);
  assert.equal(clause, "export{$a as first,_$b as second,c$$};");
  assert.deepEqual(bindings, [{ local: "$a", name: "first" }, { local: "_$b", name: "second" }, { local: "c$$", name: "c$$" }]);
  const { linked, names } = linkBridge(source);
  assert.deepEqual(names, ["first", "second", "c$$"]);
  const context = vm.createContext({});
  context.window = context;
  vm.runInContext(`(()=>{${linked}\n})();`, context);
  assert.deepEqual([context.window.first, context.window.second(), context.window["c$$"]], [1, 2, 3]);
  assert.throws(() => bridgeExports("const a=1;"), /exactly one export clause/u);
  assert.throws(() => bridgeExports("export{a as b};export{c as d};"), /exactly one export clause/u);
});


test("R46 I09: a common default that does not resolve is read, named unavailable, and taken out from the page", async () => {
  const fixture = await projectChainFixture("tcrn-r46-i09-common-");
  await cli(["project-bindings-set", "--workspace", fixture.workspace, "--project-id", fixture.projectId, "--at", nextAt(), "--actor", "agent:test", "--key", "common-default", "--value", JSON.stringify(GHOST_TARGET)], fixture.atelier);
  const locales = await localeTable();
  const page = await loadExecutedDom(fixture);
  try {
    const { document } = page;
    document.querySelector('[data-page-target="settings"]')?.click();
    document.querySelector('[data-setting-group="general"]')?.click();
    const bindings = await waitFor(() => document.querySelector("[data-project-bindings] [data-common-source]")?.closest("[data-project-bindings]"), "the project bindings section");
    assert.equal(document.querySelector('[data-settings-state="error"]'), null, "the target's settings are read, not refused");
    const row = document.querySelector('[data-setting-row="design.authority"]');
    const provenance = row?.querySelector('.tcrn-field-provenance[data-setting-unresolved="design.authority"]');
    assert.equal(provenance?.querySelector(".tcrn-field-provenance__value")?.textContent, "\u2014", "an inheriting key has no value");
    assert.equal(provenance.querySelector(".tcrn-field-provenance__source").textContent, locales.en["settings.unresolvedValue"]);
    assert.equal(row.querySelector("[data-setting-control]"), null, "no default is offered in its place");
    assert.equal(row.querySelector("[data-effective-source]").textContent, locales.en["projects.commonUnavailable"]);
    const notice = bindings.querySelector("[data-common-default-unresolved]");
    assert.equal(notice?.dataset.commonDefaultUnresolved, "common-default-unresolved");
    assert.equal(notice.querySelector("span").textContent, locales.en["projects.commonUnresolved"].replace("{status}", locales.en["projects.statusUnregistered"]));
    const options = [...bindings.querySelectorAll("[data-common-source] option")];
    assert.equal(options[1].textContent, locales.en["projects.unavailable"], "the saved choice comes first, named unavailable");
    assert.equal(options[1].hasAttribute("selected"), true);
    assert.equal(options.filter((option) => option.hasAttribute("selected")).length, 1);
    // Stopping the inheritance from the page removes the binding, and the target reads plainly again.
    const before = receiptText(document);
    bindings.querySelector("[data-remove-common]").click();
    await waitFor(receiptAdvanced(document, before), "the removal's receipt");
    await waitFor(() => document.querySelector("[data-project-bindings] [data-common-source]") && document.querySelector("[data-common-default-unresolved]") === null && document.querySelectorAll("[data-setting-unresolved]").length === 0, "the settings read without an unresolved common default");
    assert.ok(document.querySelector('[data-setting-row="design.authority"] [data-setting-control]'), "the key has its control again");
    assert.equal(document.querySelector("[data-project-bindings] [data-common-source] option[selected]"), null, "no common default is saved");
    const settings = await cli(["settings-catalog", "--workspace", fixture.workspace, "--project-id", fixture.projectId], fixture.deviceEnv);
    assert.equal(Object.hasOwn(settings, "commonDefault"), false);
  } finally { await closePage(page, fixture); }
});


// INIT-056 R5: real host switches use maps rather than prototype-keyed draft objects, and both the
// host-specific read and a shared refresh participate in one monotonic read-generation protocol.
test("INIT-056 R5: host changes reject an old Save and an older specialized read cannot replace a newer shared refresh", async () => {
  const fixture = await scratch("tcrn-init056-r5-host-race-");
  const meeting = await cli([
    "minutes-record", "--workspace", fixture.workspace, "--at", nextAt(), "--project-id", fixture.projectId,
    "--external-key", "INIT056-R5-HOSTS", "--title", "Engine policy host reads",
    "--summary", "Owner authorizes the test engine model policy writes.", "--decisions", "Set models.engine-policy for the Codex host.",
    "--decided-by", "owner:governance", "--actor", "agent:test",
  ], fixture.deviceEnv);
  const decision = `${meeting.id}#D1`;
  const policy = (host, model, note) => ({
    categories: [{ order: 10, id: "main", name: "Main", description: "" }],
    tiers: [{ order: 10, category: "main", runner: host, model, effort: "max", note }],
    escalation: { enabled: true, threshold: 2, ceiling: "main" },
  });
  for (const [host, model] of [["codex", "codex-initial"], ["constructor", "constructor-old"]]) {
    await cli(["engine-model-policy-set", "--workspace", fixture.workspace, "--host", host, "--policy", JSON.stringify(policy(host, model, "seed")), "--at", nextAt(), "--actor", "agent:test", "--decided-in", decision], fixture.deviceEnv);
  }
  const page = await loadExecutedDom(fixture);
  try {
    const { document, window } = page;
    const view = () => document.querySelector("#engine-model-policy-view");
    const host = () => view().querySelector("[data-engine-model-policy-host]");
    const model = () => view().querySelector('[data-engine-policy-kind="tiers"][data-engine-policy-index="0"][data-engine-policy-field="model"]');
    const note = () => view().querySelector('[data-engine-policy-kind="tiers"][data-engine-policy-index="0"][data-engine-policy-field="note"]');
    const save = () => view().querySelector("[data-engine-model-policy-save]");
    const type = (node, value) => { node.value = value; node.dispatchEvent(new window.Event("input", { bubbles: true })); };
    const selectHost = (value) => { host().value = value; host().dispatchEvent(new window.Event("change", { bubbles: true })); };

    document.querySelector('[data-page-target="engine-model-policy"]').click();
    assert.ok([...host().querySelectorAll("option")].some((option) => option.value === "constructor"), "a legal constructor host is offered without prototype inheritance");
    selectHost("constructor");
    await page.waitForSettled();
    await waitFor(() => model()?.value === "constructor-old", "the constructor host policy");
    type(note(), "constructor draft remains distinct");
    const oldSave = save();

    page.hold((path) => path === "/api/model-policy?host=codex");
    selectHost("codex");
    await waitFor(() => page.held() === 1, "the target host policy read to be pending");
    assert.equal(host().disabled, true, "a pending host read prevents another target switch");
    const postsBeforeOldSave = page.requests.filter((path) => path === "/api/model-policy").length;
    oldSave.click();
    assert.equal(page.requests.filter((path) => path === "/api/model-policy").length, postsBeforeOldSave, "the old host Save closure cannot write after a host switch");
    assert.equal(page.release(), 1);
    await page.waitForSettled();
    await waitFor(() => model()?.value === "codex-initial", "the selected codex host policy");

    page.hold((path) => path.startsWith("/api/model-policy?host="));
    selectHost("constructor");
    await waitFor(() => page.held() === 1, "the specialized constructor read");
    document.querySelector('[data-page-target="settings"]').click();
    document.querySelector('[data-setting-group="execution"]').click();
    const concurrency = document.querySelector('[data-setting-control="execution.maxConcurrentSubagents"]');
    concurrency.value = "3";
    concurrency.dispatchEvent(new window.Event("change", { bubbles: true }));
    await waitFor(() => page.held() === 2, "the newer shared refresh policy read");
    assert.equal(page.release({ where: (path) => path === "/api/model-policy?host=constructor", keepHolding: true, limit: 1 }), 1);
    await page.waitForSettled();
    await cli(["engine-model-policy-set", "--workspace", fixture.workspace, "--host", "constructor", "--policy", JSON.stringify(policy("constructor", "constructor-new", "newer shared read")), "--at", nextAt(), "--actor", "agent:test", "--decided-in", decision], fixture.deviceEnv);
    assert.equal(page.release(), 1);
    await page.waitForSettled();
    document.querySelector('[data-page-target="engine-model-policy"]').click();
    assert.equal(note().value, "constructor draft remains distinct", "neither read overwrites an unsaved host draft");
    const postsBeforeRoundTripSave = page.requests.filter((path) => path === "/api/model-policy").length;
    oldSave.click();
    assert.equal(page.requests.filter((path) => path === "/api/model-policy").length, postsBeforeRoundTripSave, "a host round trip cannot revalidate a detached old Save closure");
    view().querySelector("[data-engine-model-policy-undo]").click();
    await waitFor(() => model()?.value === "constructor-new", "Undo reveals the newest accepted read");
    assert.equal(note().value, "newer shared read");
  } finally { await closePage(page, fixture); }
});


if (!MUTATION) test("DOM setup failure retains child stderr and removes its owned fixture", async () => {
  const fixture = await scratch("tcrn-dom-setup-failure-");
  await assert.rejects(loadExecutedDom(fixture, { TCRN_PORTAL_ACTOR: "" }), (error) => {
    assert.match(error.message, /portal startup failed/u);
    assert.match(error.message, /stderr:[\s\S]*PORTAL_ACTOR_REQUIRED/u);
    assert.match(error.message, /exit=2/u);
    assert.ok(error.cause instanceof Error, "the original setup failure is retained");
    return true;
  });
  await assert.rejects(readFile(join(fixture.proseRoot, "AGENTS.md")), { code: "ENOENT" });
});


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
