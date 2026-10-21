// SPDX-License-Identifier: Apache-2.0
// Tests in this file run sequentially; Node isolates each file in a process.
import { CLI, DS_CONTRACT, GHOST_TARGET, MUTATION, assert, assertBehaviorContract, assertDomContract, bridgeExports, cli, closePage, join, keydown, linkBridge, loadExecutedDom, localeTable, nextAt, pageHierarchyFindings, portalRoot, preparePage, projectChainFixture, readFile, receiptAdvanced, receiptText, rm, scratch, test, topbarFindings, vm, waitFor, writeFile, writeScratch } from "./ui-presence-support.mjs";

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
      // INC-193 / INC-221: response headers and a quiet period do not establish
      // response consumption or handler completion. Each stage has one 15s budget,
      // binds its exact contract URL and observes a fresh panel node after json()
      // consumption, even when two warning bodies render the same text. The current
      // control must also be rebuilt and released by the settings handler's finally.
      const changeAuthority = async (url, body, label) => {
        const startedAt = Date.now();
        const deadline = startedAt + 15_000;
        const expectedContract = new URL("/tcrn-design-authority.json", url).href;
        const currentInput = () => page.document.querySelector('[data-setting-control="design.authority"]');
        const currentPanel = () => page.document.querySelector("#design-authority [data-design-authority-state]");
        const editable = () => {
          const control = currentInput();
          return control && !control.disabled && !control.hasAttribute("data-write-busy") ? control : null;
        };
        const beforeReceipt = receiptText(page.document);
        const observed = { requested: 0, bodyConsumed: 0, otherContracts: 0, method: null };
        let phase = "control-ready";
        let input = null;
        let panelAtConsumption = null;
        const panelReplaced = () => observed.bodyConsumed > 0 && currentPanel() !== null && currentPanel() !== panelAtConsumption;
        const waitWithinBudget = (predicate, stage) => waitFor(predicate, `${label}: ${stage}`, Math.max(0, deadline - Date.now()));
        page.window.fetch = (request, options) => {
          const target = String(request);
          if (!target.includes("tcrn-design-authority.json")) return realFetch(request, options);
          if (target !== expectedContract) {
            observed.otherContracts += 1;
            return Promise.resolve({ ok: false, status: 404 });
          }
          observed.requested += 1;
          observed.method = options?.method ?? "GET";
          return Promise.resolve({ ok: true, status: 200, json: async () => {
            observed.bodyConsumed += 1;
            panelAtConsumption = currentPanel();
            return body;
          } });
        };
        try {
          input = await waitWithinBudget(editable, phase);
          assert.ok(Date.now() < deadline, "the original stage budget remains before dispatch");
          phase = "write-refresh-response-consumption";
          input.value = url;
          input.dispatchEvent(new page.window.Event("change", { bubbles: true }));
          await waitWithinBudget(() => {
            if (!observed.bodyConsumed) return false;
            phase = "panel-replaced-and-handler-released";
            return panelReplaced() && currentInput() !== input && editable();
          }, "matching response consumption, panel replacement and editable current control");
          assert.equal(currentInput().value, url, "the rendered setting belongs to this stage");
        } catch (error) {
          // Bounded, body-free stage facts, not settings/response text or a DOM dump.
          const control = currentInput();
          error.message += `; stage=${JSON.stringify({ label, phase, elapsedMs: Date.now() - startedAt,
            ...observed, receiptAdvanced: Boolean(receiptAdvanced(page.document, beforeReceipt)()),
            panelReplaced: panelReplaced(), controlRebuilt: Boolean(control && control !== input),
            controlPresent: Boolean(control), disabled: control?.disabled ?? null,
            writeBusy: control?.hasAttribute("data-write-busy") ?? null })}`;
          throw error;
        }
      };

      for (const [key, value] of Object.entries({"design.repository":"https://design.example.test/repository","design.pullRequestTarget":"main","design.productionDocs":"https://design.example.test/docs","design.buildService":"Example build","design.buildProject":"Example docs","design.consumedVersion":"9.9.9"})) {
        await writeScratch(page.fixture, "settings-set", ["--key", key, "--value", value]);
      }
      await changeAuthority("https://design.example.test/", { schemaVersion: "tcrn.design-authority.v1", name: "Example System", version: "9.9.9" }, "declared contract");
      await page.waitForSettled();
      const declared = page.document.querySelector("[data-design-authority-state]");
      assert.equal(declared?.dataset.designAuthorityState, "declared");
      assert.match(declared.textContent, /Example System/u);
      assert.match(declared.textContent, /9\.9\.9/u);
      assert.ok(!declared.className.includes("--warning"), "a contract that answered is not a warning");

      // A response that is not this platform's contract is yellow, not red: the fact is
      // outside this machine, so nothing here can be called false. The message has to
      // say what would turn it green, or a yellow becomes a permanent decoration.
      await changeAuthority("https://other.example.test/", { hello: "world" }, "foreign response");
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
      await changeAuthority("https://third.example.test/", { schemaVersion: "someone.elses.contract.v1", name: "Example System", version: "9.9.9" }, "body under another contract");
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
