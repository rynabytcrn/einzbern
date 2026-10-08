// SPDX-License-Identifier: Apache-2.0
// INC-148: the portal contract is evaluated against a parsed, executed DOM.
// linkedom is test-only; portal/index.html remains dependency-free at runtime.

// Every CLI and portal child inherits the test process's device directory, never the real one.
import "../../tests/helpers/device-home.mjs";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { parseHTML } from "linkedom";
import { historicalModelPlan } from "../../tests/helpers/model-plan-history.mjs";

const execFileAsync = promisify(execFile);
const portalRoot = fileURLToPath(new URL("..", import.meta.url));
const CLI = process.env.TCRN_WORKFLOW_CLI ?? join(portalRoot, "..", "scripts", "einzbern.mjs");
const DS_CONTRACT = JSON.parse(await readFile(join(portalRoot, "ds-consumer-contract.json"), "utf8"));
const fixtureProjectIds = new Map();
const GLOBAL_SETTING_KEYS = new Set(["engine.requiredVersion", "storage.segmentBytes", "storage.snapshotEveryEvents", "workspace.generatedArtifactsPath"]);
// TCRN-CROSS-INIT-053 R47 (c1-B): a coordination chain writes these for the whole library as well, so a fixture
// write of one to a coordination library names no project either.
const COORDINATION_SETTING_KEYS = new Set([...GLOBAL_SETTING_KEYS, "artifact.language", "execution.maxConcurrentSubagents", "quota.fiveHourParallelOffPercent", "quota.fiveHourWaitPercent", "quota.weeklyParallelOffPercent", "quota.weeklyWaitPercent"]);
const coordinationLibraries = new Set();
const MUTATION = process.env.TCRN_UI_MUTATION ?? "";
const COMPONENTS = Object.freeze([
  ["workspace tabs", '[data-ui="workspace-tabs"]'],
  ["built-in rule list", '[data-ui="rule-list"]'],
  ["rule switches", '[data-rule-switch]'],
  ["pending rule actions", '[data-ui="rules-pending"] [data-pending-action]'],
  ["prose line-number gutter", '[data-ui="prose-gutter"]'],
  ["prose finding link", '[data-ui="prose-finding-link"]'],
  ["work tree", '[data-ui="work-tree"]'],
  ["knowledge view", '[data-ui="knowledge-view"]'],
  ["library switcher", '[data-ui="library-switcher"]'],
  ["engine connection", '[data-ui="engine-connection"]'],
  ["setting modified dot", '[data-ui="setting-modified-dot"]'],
  ["DS NumberInput", ".tcrn-number-input"],
  ["model tiers table", '[data-ui="model-tiers-table"]'],
  ["model categories table", '[data-ui="model-categories-table"]'],
  ["collection table component", '[data-collection-component="CollectionTable"]'],
  ["variables view", '[data-ui="variables-view"]'],
  ["gate configuration table", '[data-ui="gate-config-table"]'],
  ["gate add form", '[data-ui="gate-add-form"]'],
  ["latest gate run", '[data-ui="gates-last-run"]'],
  ["returned stat card", ".tcrn-stat-card"],
  ["returned setting row", ".tcrn-setting-row"],
  ["returned line-numbered editor", ".tcrn-line-numbered-editor"],
  ["returned app status bar", ".tcrn-app-status-bar"],
  ["receipt chip", '[data-ui="receipt-chip"]'],
  ["receipt drawer", '[data-ui="receipt-drawer"]'],
]);

let logicalAt = Date.parse("2026-08-13T00:00:00Z");
const nextAt = () => new Date(logicalAt += 1000).toISOString();

async function cli(args, env = {}) {
  // An executed Atelier fixture reads its explicitly registered native project, never an
  // inferred directory identity. Library-owned settings deliberately have no project target.
  const scoped = ["settings-catalog", "settings-set", "settings-remove", "gates-config-list", "gates-config-set", "gates-config-remove", "variable-list", "variable-set", "variable-remove"];
  const workspaceIndex = args.indexOf("--workspace");
  const projectId = fixtureProjectIds.get(args[workspaceIndex + 1]);
  const keyIndex = args.indexOf("--key");
  const libraryKeys = coordinationLibraries.has(args[workspaceIndex + 1]) ? COORDINATION_SETTING_KEYS : GLOBAL_SETTING_KEYS;
  if (scoped.includes(args[0]) && projectId && !args.includes("--project-id") && !libraryKeys.has(args[keyIndex + 1])) args = [...args, "--project-id", projectId];
  const { stdout } = await execFileAsync(process.execPath, [CLI, ...args], { encoding: "utf8", maxBuffer: 32e6, env: { ...process.env, ...env } });
  return JSON.parse(stdout);
}

// TCRN-CROSS-STORY-482 R3: Atelier opens the libraries a device has registered, so a fixture is a
// device of its own (an EINZBERN_HOME inside it, removed with it; every CLI and portal child of the
// fixture runs as that device) whose registry holds two libraries: the fixture's library, kept in
// its project beside the project's AGENTS.md, and a second library kept outside its project.
async function registeredLibrary(deviceEnv, project, library, externalKey) {
  await mkdir(project, { recursive: true });
  await cli(["init", "--workspace", library, "--project-name", externalKey, "--at", nextAt()], deviceEnv);
  const created = await cli(["project-create", "--workspace", library, "--external-key", externalKey, "--name", externalKey, "--at", nextAt()], deviceEnv);
  const projectId = created.record.id;
  await cli(["library-register", "--project", project, "--library", library, "--project-id", projectId, "--at", nextAt()], deviceEnv);
  fixtureProjectIds.set(library, projectId);
  return projectId;
}

async function scratch(prefix) {
  const base = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  // TCRN-CROSS-INC-386: the portal and every CLI it starts read and write machine settings
  // under HOME, so each fixture carries its own scratch HOME, removed with the fixture.
  const home = join(base, "home");
  await mkdir(home);
  const deviceEnv = { EINZBERN_HOME: join(base, "device", "einzbern") };
  const proseRoot = join(base, "project");
  const workspace = join(proseRoot, ".ether");
  const projectId = await registeredLibrary(deviceEnv, proseRoot, workspace, "TCRN-INC148-DOM");
  // A registered key and an unregistered one in a registered namespace (the backup namespace
  // retired with TCRN-CROSS-STORY-484 R3, and reconciliation reads only registered namespaces).
  await writeFile(join(proseRoot, "AGENTS.md"), "# Workspace rules\n\nretrieval.tau\nretrieval.unknown\n", "utf8");
  const second = { project: join(base, "second-project"), library: join(base, "second-library") };
  second.projectId = await registeredLibrary(deviceEnv, second.project, second.library, "TCRN-INC148-DOM-SECOND");
  return { base, workspace, proseRoot, home, deviceEnv, projectId, second };
}

async function writeScratch(fixture, command, args) {
  // The engine serialises writers with its own lock (TCRN-CROSS-STORY-467 R1): no version to read first.
  return cli([command, "--workspace", fixture.workspace, "--at", nextAt(), "--actor", "agent:test", ...args], { ...fixture.deviceEnv, EINZBERN_SURFACE: "atelier" });
}

// The helper runs as the test process's device; the fixture's device is lent to it for the call,
// so every event in the fixture's library comes from one device.
async function asFixtureDevice(fixture, operation) {
  const previous = process.env.EINZBERN_HOME;
  process.env.EINZBERN_HOME = fixture.deviceEnv.EINZBERN_HOME;
  try { return await operation(); } finally { process.env.EINZBERN_HOME = previous; }
}

// TCRN-CROSS-SUB-406 (TCRN-CROSS-STORY-508 R3): a setting recorded as replay reads a merged value, through
// the engine's own append and without the checks a settings-set runs, since a merge may bring the two
// model tables apart. The fixture's device is lent to it, as to the historical records above.
async function mergedSetting(fixture, key, value) {
  const moduleUrl = new URL("../../dist/build/packages/core/src/index.js", import.meta.url).href;
  const script = `const m = await import(${JSON.stringify(moduleUrl)}); const [workspace, key, value, at] = process.argv.slice(1);
await m.appendEvents(workspace, [(state) => {
  const record = { schemaVersion: "tcrn.workspace-setting.v1", key, layerKind: "workspace_configuration", value, revision: (state.settings.find((entry) => entry.key === key)?.revision ?? 0) + 1, updatedAt: at, tombstone: false };
  return { payload: { operation: "settings.updated", record }, projects: state.projects, work: state.work, settings: m.sortWorkspaceSettings([...state.settings.filter((entry) => entry.key !== key), record]) };
}], { occurredAt: at });`;
  await asFixtureDevice(fixture, () => execFileAsync(process.execPath, ["--input-type=module", "-e", script, fixture.workspace, key, value, nextAt()], { encoding: "utf8" }));
}

async function seed(fixture) {
  await asFixtureDevice(fixture, () => historicalModelPlan(fixture.workspace, "set", { host: "claude-code", name: "budget", defaultModel: "claude-sonnet-4-5" }, nextAt()));
  // The setting that pointed at the plan, execution.claudeCodeSubagentPlan, is retired
  // (TCRN-CROSS-STORY-484 R3): a write of it is refused, so the fixture records the plan only.
}

function mutateSource(source, mutation) {
  if (mutation === "assignment-addline") return source.replaceAll('data-ui="assignment-addline"', 'data-ui="assignment-addline-mutated"');
  if (mutation === "receipt-click") return source.replace('$("#receipt-chip").addEventListener("click", openReceipt); ', "");
  if (mutation === "receipt-stale") return source.replace(/setText\("#receipt-chip-text", state\.receipt\.version \? [\s\S]*?\);\n    renderReceipt\(\);/u, 'setText("#receipt-chip-text", "idle");\n    renderReceipt();');
  if (mutation === "s253-old-class") return source.replace('class="tcrn-top-bar"', 'class="tcrn-topbar"');
  if (mutation === "s255-missing-component-css") return source.replace(".tcrn-switch {", ".tcrn-switch-mutated {");
  if (mutation === "s275-missing-nav-name") return source.replace('aria-label="Status" data-i18n-aria-label="nav.dashboard"', "");
  if (mutation === "s275-missing-brand-mark") return source.replace('data-brand-asset="tcrn-brand-mark"', 'data-brand-asset="tcrn-brand-mark-mutated"');
  return source;
}

function installDomShims(window) {
  const nativeFetch = globalThis.fetch;
  window.CSS = { escape: (value) => String(value).replace(/[^a-zA-Z0-9_-]/gu, (character) => `\\${character}`) };
  window.navigator.clipboard = { writeText: async () => {} };
  window.window = window;
  window.self = window;
  window.globalThis = window;
  window.setTimeout = setTimeout;
  window.clearTimeout = clearTimeout;
  window.console = console;
  const datasetDescriptor = Object.getOwnPropertyDescriptor(window.Element.prototype, "dataset");
  assert.ok(datasetDescriptor?.get, "DOM harness must expose Element.dataset");
  Object.defineProperty(window.Element.prototype, "dataset", {
    configurable: true,
    get() {
      const element = this;
      const nativeDataset = datasetDescriptor.get.call(element);
      return new Proxy(nativeDataset, {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver);
          if (typeof property !== "string" || value !== null && value !== undefined) return value;
          const attribute = `data-${property.replace(/[A-Z]/gu, (character) => `-${character.toLowerCase()}`)}`;
          const raw = element.getAttribute(attribute);
          return raw === null ? value : raw;
        },
      });
    },
  });
  const optionPrototype = window.HTMLOptionElement.prototype;
  Object.defineProperty(optionPrototype, "selected", { configurable: true, get() { return this.hasAttribute("selected"); }, set(value) { if (this.hasAttribute("selected") === Boolean(value)) return; if (value) this.setAttribute("selected", ""); else this.removeAttribute("selected"); } });
  // Match the native option label fallback that the published bridge reads.
  Object.defineProperty(optionPrototype, "label", { configurable: true, get() { return this.getAttribute("label") ?? this.textContent; }, set(value) { this.setAttribute("label", String(value)); } });
  const selectPrototype = window.HTMLSelectElement.prototype;
  Object.defineProperty(selectPrototype, "selectedOptions", { configurable: true, get() { return [...this.querySelectorAll("option[selected]")]; } });
  Object.defineProperty(selectPrototype, "value", {
    configurable: true,
    get() {
      const option = this.querySelector("option[selected]") || this.querySelector("option");
      return option?.getAttribute("value") ?? option?.textContent ?? "";
    },
    set(value) {
      for (const option of this.querySelectorAll("option")) {
        if (option.getAttribute("value") === String(value)) option.setAttribute("selected", "");
        else option.removeAttribute("selected");
      }
    },
  });
  return nativeFetch;
}

async function startPortal(fixture, env = {}) {
  assert.ok(fixture.home, "every portal child needs the fixture scratch HOME (TCRN-CROSS-INC-386)");
  const child = spawn(process.execPath, [join(portalRoot, "portal.mjs"), "--library", fixture.workspace, "--port", "0"], {
    env: { ...process.env, TCRN_WORKFLOW_CLI: CLI, ...fixture.deviceEnv, ...env, HOME: fixture.home },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const url = await new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error(`portal did not start: ${buffer}`)), 15000);
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const line = buffer.split("\n").find((entry) => entry.includes("PORTAL_LISTENING"));
      if (line) { clearTimeout(timer); resolve(JSON.parse(line).url); }
    });
    child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`portal exited ${code}: ${buffer}`)); });
  });
  return { child, url };
}

// TCRN-CROSS-INIT-053 R46 (I10, U20 D13): a second page can be loaded from a portal already running, as a
// second browser tab of the same Atelier is.
// TCRN-CROSS-INIT-053 R46 S19 (I20/I23): the published bridge is read as data. Its one export clause
// lists every binding as `local as exported` (or a bare name), whatever its minifier called the locals
// (a `$` among them) and however many it exports; linking puts each on the window under its exported
// name, and a function replacement keeps `$` patterns in a local name literal.
const BRIDGE_IDENTIFIER = String.raw`[\p{ID_Start}$_][\p{ID_Continue}$\u200c\u200d]*`;
function bridgeExports(source) {
  const clauses = [...source.matchAll(/export\s*\{([^{}]*)\}\s*;?/gu)];
  assert.equal(clauses.length, 1, "the published bridge has exactly one export clause");
  const entry = new RegExp(`^(${BRIDGE_IDENTIFIER})(?:\\s+as\\s+(${BRIDGE_IDENTIFIER}))?$`, "u");
  const bindings = clauses[0][1].split(",").map((part) => part.trim()).filter((part) => part !== "").map((part) => {
    const match = entry.exec(part);
    assert.ok(match, `the bridge export ${part} names a binding`);
    return { local: match[1], name: match[2] ?? match[1] };
  });
  return { clause: clauses[0][0], bindings };
}
function linkBridge(source) {
  const { clause, bindings } = bridgeExports(source);
  const assignments = bindings.map(({ local, name }) => `window[${JSON.stringify(name)}]=${local};`).join("");
  return { linked: source.replace(clause, () => assignments), names: bindings.map(({ name }) => name) };
}

async function loadExecutedDom(fixture, env = {}, { hold = () => false, portal = null } = {}) {
  const { child, url } = portal ?? await startPortal(fixture, env);
  const nativeFetch = globalThis.fetch;
  let source = await (await nativeFetch(url)).text();
  source = mutateSource(source, MUTATION);
  const { window, document } = parseHTML(source, { url });
  installDomShims(window);
  // TCRN-CROSS-INC-221. This used to end in `setTimeout(900)`, which is the very thing the
  // comment below `waitFor` warns against: too short and the assertion reads a DOM that has
  // not been filled, too long and every run pays the worst case. It read `—` out of
  // #stat-engine under load — in the sweep AND in preflight's isolated clone, so not a
  // local-contention flake.
  //
  // The harness already owns the page's fetch, so it can count what is in flight and wait
  // for the real settle signal instead of guessing at one. Waiting on in-flight requests
  // rather than on any asserted field is deliberate: a test that waited for #stat-engine
  // would turn a genuine regression into a timeout instead of a readable difference.
  let inFlight = 0;
  let lastSettled = Date.now();
  // Every path the page asks for, in order, so a case can state what the page never requests.
  const requests = [];
  const send = (path, options) => {
    inFlight += 1;
    lastSettled = Date.now();
    return nativeFetch(new URL(path, url), options).finally(() => {
      inFlight -= 1;
      lastSettled = Date.now();
    });
  };
  // TCRN-CROSS-SUB-416: a case can hold back the requests its `hold` names. A held request stays
  // unanswered, and outside the settle count, until the case lets it go: `release()` sends it on,
  // and `release({ error })` fails it as a broken connection would. Releasing ends the hold, and
  // `hold(predicate)` begins another.
  let holding = hold;
  const held = [];
  window.fetch = (path, options = {}) => {
    requests.push(String(path));
    if (!holding(String(path))) return send(path, options);
    return new Promise((resolveHeld, rejectHeld) => { held.push({ path, options, resolveHeld, rejectHeld }); });
  };
  const release = ({ error } = {}) => {
    holding = () => false;
    const waiting = held.splice(0);
    for (const entry of waiting) {
      if (error === undefined) entry.resolveHeld(send(entry.path, entry.options));
      else entry.rejectHeld(error);
    }
    lastSettled = Date.now();
    return waiting.length;
  };
  const context = vm.createContext(window);
  for (const script of [...document.querySelectorAll("script")]) {
    if (script.src) {
      const scriptSource = await (await nativeFetch(new URL(script.src, url))).text();
      vm.runInContext(scriptSource, context);
    } else if (script.textContent.trim()) {
      let executable = script.textContent;
      if (script.type === "module") {
        // Link the exact served ES module in this CommonJS-style VM harness. The product
        // snapshot and module import stay untouched; aliases are read from its own export.
        const bridgeSource = await (await nativeFetch(new URL("/ds-static-bridges.snapshot.js", url))).text();
        const { linked: linkedBridge, names } = linkBridge(bridgeSource);
        assert.ok(["mountStaticMultiSelect", "mountStaticOverlayBoundary"].every((name) => names.includes(name)), "the published bridge must export both declared bindings");
        vm.runInContext(`(()=>{${linkedBridge}\n})();`, context);
        executable = executable.replace(/^\s*import \{ mountStaticMultiSelect, mountStaticOverlayBoundary \} from [^;]+;\s*/u, "const { mountStaticMultiSelect, mountStaticOverlayBoundary } = window;\n");
      }
      vm.runInContext(executable, context);
    }
  }
  // The quiet period covers a handler that starts its next request from the previous
  // response; a page that fetches nothing settles well inside the old 900ms.
  await waitFor(
    () => inFlight === 0 && Date.now() - lastSettled >= 150,
    "the page's initial fetches to settle",
    20_000,
  );
  const waitForSettled = () => waitFor(
    () => inFlight === 0 && Date.now() - lastSettled >= 150,
    "the page's requests to settle",
    20_000,
  );
  // TCRN-CROSS-INIT-053 R47 (R46-REG-1): a request from outside the page, over the loopback channel the
  // page itself was loaded through. It is neither one of the page's requests nor counted in its settling,
  // so a case can read or change the server's state as another client would.
  const serverRequest = (path, options) => nativeFetch(new URL(path, url), options);
  return { child, url, document, source, window, requests, waitForSettled, serverRequest, held: () => held.length, release, hold: (predicate) => { holding = predicate; } };
}

function missingComponents(document) {
  return COMPONENTS.filter(([, selector]) => document.querySelectorAll(selector).length === 0)
    .map(([name, selector]) => ({ name, selector }));
}

const hierarchyPages = Object.freeze(["dashboard", "settings", "model-categories", "model-tiers", "variables", "gates", "prose", "vocabulary"]);
const topbarDesignMap = Object.freeze([
  ["product-shell-header", "header.tcrn-top-bar", "ProductShell/TopBar", "https://tcrn-design-system-storybook.vercel.app/components-navigation-shells.html#navigation-shell-spec"],
  ["library-select", "#library-select", "Select", "https://tcrn-design-system-storybook.vercel.app/components-controls-data.html#field-spec-usage"],
  ["engine-status", "#engine-connection", "Badge", "https://tcrn-design-system-storybook.vercel.app/proof-proof-visual-instances.html#owner-quality-product-shell"],
  ["workspace-search", "#global-search", "SearchInput", "https://tcrn-design-system-storybook.vercel.app/components-navigation-shells.html#navigation-shell-spec"],
  ["theme-toggle", "#theme-button", "ThemeToggle", "https://tcrn-design-system-storybook.vercel.app/components-navigation-shells.html#navigation-shell-spec"],
  ["locale-menu", "#locale-menu", "LocaleMenu", "https://tcrn-design-system-storybook.vercel.app/components-navigation-shells.html#navigation-shell-spec"],
  ["receipt-chip", "#receipt-chip", "Badge/Button", "https://tcrn-design-system-storybook.vercel.app/proof-proof-visual-instances.html#owner-quality-product-shell"],
]);

function childIndex(parent, child) {
  return [...parent.children].indexOf(child);
}

function pageHierarchyFindings(document, source) {
  const findings = [];
  const pages = hierarchyPages.map((name) => document.querySelector(`[data-page="${name}"]`));
  const hierarchies = pages.map((page) => page?.querySelector(':scope > [data-page-hierarchy="true"]'));
  if (document.querySelectorAll('[data-page-hierarchy="true"]').length !== hierarchyPages.length) findings.push("page-level-marker-count");
  for (const [name, page, hierarchy] of hierarchyPages.map((name, index) => [name, pages[index], hierarchies[index]])) {
    if (!page || !hierarchy || hierarchy.getAttribute("data-page-hierarchy-depth") !== "two") { findings.push(`${name}:page-level`); continue; }
    const headRegion = hierarchy.querySelector(':scope > [data-page-hierarchy-region="header"]');
    const head = headRegion?.querySelector(":scope > .tcrn-page__head");
    const tabsRegion = hierarchy.querySelector(':scope > [data-page-hierarchy-region="section-tabs"]');
    const lowerContent = hierarchy.querySelector(':scope > [data-page-hierarchy-region="lower-content"]');
    if (!headRegion || !head || childIndex(hierarchy, headRegion) !== 0 || childIndex(headRegion, head) !== 0) findings.push(`${name}:header-first`);
    if (!tabsRegion || !lowerContent || childIndex(hierarchy, tabsRegion) >= childIndex(hierarchy, lowerContent)) findings.push(`${name}:tabs-before-content`);
    if (name === "dashboard") {
      const tabs = tabsRegion?.querySelector('[data-ui="workspace-tabs"]');
      const panels = [...lowerContent?.querySelectorAll(":scope > [data-workspace-panel]") ?? []];
      if (!tabs || panels.length === 0 || !lowerContent || panels.some((panel) => childIndex(lowerContent, panel) < 0)) findings.push("dashboard:tabs-before-content");
    }
    if (name === "settings") {
      const nav = tabsRegion?.querySelector("[data-settings-layout-nav]");
      const layout = lowerContent?.querySelector('[data-settings-layout-component="SettingsLayout"]');
      const grid = layout?.querySelector("[data-settings-layout-grid]");
      const content = layout?.querySelector("[data-settings-layout-content]");
      if (!grid || !nav || !content || childIndex(grid, content) !== 0 || childIndex(tabsRegion, nav) !== 0) findings.push("settings:tabs-before-content");
      if (content?.contains(nav)) findings.push("settings:local-nav-inside-content");
    }
    if (name === "variables") {
      const view = lowerContent?.querySelector(':scope > [data-ui="variables-view"]');
      if (!view || childIndex(lowerContent, view) !== 0) findings.push("variables:tabs-before-content");
    }
    // TCRN-CROSS-SUB-409: each collection page states what its order means in its header, and its
    // table view is the first thing under the section notes.
    if (name === "model-categories" || name === "model-tiers") {
      const view = lowerContent?.querySelector(`:scope > [data-ui="${name}-view"]`);
      const purpose = head?.querySelector(".tcrn-page__lede[data-collection-purpose]");
      if (!view || childIndex(lowerContent, view) !== 0 || !purpose) findings.push(`${name}:collection-view`);
    }
    if (name === "gates") {
      const view = lowerContent?.querySelector(':scope > [data-ui="gates-view"]');
      const table = view?.querySelector('[data-ui="gate-config-table"]');
      const form = view?.querySelector('[data-ui="gate-add-form"]');
      const lastRun = view?.querySelector('[data-ui="gates-last-run"]');
      // TCRN-CROSS-SUB-410: the order column leads the gate table. TCRN-CROSS-INIT-053 R46 (I15): a gate's
      // switches sit in its own cell, so the table has three columns: order, gate and covers.
      const switches = [...(table?.querySelectorAll("[data-gate-row]") ?? [])].every((row) => row.querySelectorAll("[data-gate-cell] [data-gate-switches] .tcrn-switch").length === 3 && row.querySelectorAll(":scope > .tcrn-table-shell__cell").length === 3);
      if (!view || !table || table.querySelectorAll('[role="columnheader"]').length !== 3 || !switches || !form || !lastRun || childIndex(lowerContent, view) !== 0) findings.push("gates:three-columns");
    }
    // TCRN-CROSS-SUB-410 (STORY-508 R7): the variables, rules and gates pages each say in their header
    // what their order column is for.
    const orderPurpose = { variables: "variables", prose: "rules", gates: "gates" }[name];
    if (orderPurpose !== undefined && !head?.querySelector(`.tcrn-page__lede[data-order-purpose="${orderPurpose}"]`)) findings.push(`${name}:order-purpose`);
    if (name === "prose") {
      const pending = tabsRegion?.querySelector(":scope > #rules-pending");
      const layout = lowerContent?.querySelector(':scope > [data-ui="rules-layout"]');
      const directory = layout?.querySelector(":scope > #prose-directory");
      const shell = layout?.querySelector(":scope > .tcrn-editor-shell");
      const bar = shell?.querySelector(":scope > .tcrn-editor__bar");
      const editor = shell?.querySelector(":scope > #prose-editor");
      if (!pending || !directory || !shell || !bar || !editor || childIndex(tabsRegion, pending) !== 0 || childIndex(lowerContent, layout) !== 0 || childIndex(layout, directory) !== 0 || childIndex(layout, shell) !== 1 || childIndex(shell, bar) !== 0 || childIndex(shell, editor) !== 1) findings.push("prose:rules-before-editor");
    }
    if (name === "vocabulary") {
      const nav = tabsRegion?.querySelector(":scope > #vocabulary-nav");
      const shell = lowerContent?.querySelector(":scope > .tcrn-vocabulary");
      const terms = shell?.querySelector(":scope > #vocabulary-terms");
      if (!nav || !shell || !terms || childIndex(tabsRegion, nav) !== 0 || childIndex(lowerContent, shell) !== 0 || childIndex(shell, terms) !== 0) findings.push("vocabulary:tabs-before-content");
      if (terms?.contains(nav)) findings.push("vocabulary:nav-inside-content");
    }
  }
  const sourceRules = [
    '[data-page-hierarchy="true"][data-page-hierarchy-depth="two"] [data-settings-layout-grid] { display: block; }',
    '[data-page-hierarchy="true"][data-page-hierarchy-depth="two"] .tcrn-editor-shell { display: block; }',
    '[data-page-hierarchy="true"][data-page-hierarchy-depth="two"] [data-settings-layout-nav],',
  ];
  for (const rule of sourceRules) if (!source.includes(rule)) findings.push(`source:${rule}`);
  return findings;
}

function topbarFindings(document) {
  const findings = [];
  for (const [name, selector, component, sourceUrl] of topbarDesignMap) {
    const nodes = [...document.querySelectorAll(selector)];
    if (nodes.length !== 1) { findings.push(`${name}:count`); continue; }
    const node = nodes[0];
    if (node.getAttribute("data-ds-component") !== component) findings.push(`${name}:component`);
    if (node.getAttribute("data-ds-source-url") !== sourceUrl) findings.push(`${name}:source-url`);
  }
  const header = document.querySelector("header.tcrn-top-bar");
  if (!document.querySelector("#library-details #engine-connection")) findings.push("engine-details:ownership");
  if (!document.querySelector("#library-details summary")) findings.push("engine-details:keyboard-trigger");
  const actionOrder = ["#library-select", "#global-search", "#theme-button", "#locale-menu", "#receipt-chip"]
    .map((selector) => document.querySelector(selector));
  const domOrder = header ? [header, ...header.querySelectorAll("*")] : [];
  if (actionOrder.some((node) => !node || !domOrder.includes(node))) findings.push("topbar:action-ownership");
  else if (actionOrder.some((node, index) => index > 0 && domOrder.indexOf(actionOrder[index - 1]) >= domOrder.indexOf(node))) findings.push("topbar:action-order");
  if (header?.getAttribute("data-ds-mapping-status") !== DS_CONTRACT.reconciliation.status) findings.push("topbar:mapping-status");
  return findings;
}

// A fixed sleep after a governed write is a race, not a wait: too short and the
// assertion reads a DOM that has not re-rendered, too long and every run pays for
// the worst case. Lengthening it only moves the boundary — the S280 leg below
// failed roughly one run in three at 500ms while its own receipt-chip assertion
// passed, i.e. the write had landed and only the row was behind.
//
// This polls for the condition instead, and fails with the name of what never
// arrived rather than with an empty-string diff. Callers wait for the *settle
// signal* and assert content separately, so a genuine regression still surfaces as
// an assertion difference rather than as a timeout.
async function waitFor(predicate, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() >= deadline) assert.fail(`timed out after ${timeoutMs}ms waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// The portal's own "the governed write landed" signal: the chip carries the
// version it read back. It must be waited on as a *change*, because the pattern
// alone is already true from whichever write came before — waiting for the shape
// returns instantly, the test runs ahead of the request it was supposed to wait
// for, and cleanup then kills the child mid-flight (ECONNRESET). Capture the text
// before the click and wait for it to move.
const receiptText = (document) => document.querySelector("#receipt-chip-text")?.textContent ?? "";
const receiptAdvanced = (document, before) => () => {
  const current = receiptText(document);
  return current !== before && /^✓v\d+$/u.test(current) ? current : null;
};

// TCRN-CROSS-INIT-053 R45 (U14): the page's label rule, restated for expectations. Each target has
// one base name; targets whose bases read alike carry the shortest tails of their library and project
// ids, from six characters, that tell them apart as well as the complete ids do.
function expectedTargetLabels(targets, base) {
  const tail = (target, length) => `${target.libraryId.slice(-length)}/${target.projectId.slice(-length)}`;
  const bases = targets.map(base);
  return targets.map((target, index) => {
    const peers = targets.filter((_, other) => bases[other] === bases[index]);
    if (peers.length < 2) return bases[index];
    const widest = Math.max(...peers.flatMap((peer) => [peer.libraryId.length, peer.projectId.length]));
    let length = 6;
    while (length < widest && new Set(peers.map((peer) => tail(peer, length))).size < new Set(peers.map((peer) => tail(peer, widest))).size) length += 1;
    return `${bases[index]} · ${tail(target, length)}`;
  });
}

async function localeTable() {
  const sandbox = {};
  new Function("window", await readFile(join(portalRoot, "locales.js"), "utf8"))(sandbox);
  return sandbox.PORTAL_LOCALES;
}

async function preparePage(env = {}) {
  const fixture = await scratch("tcrn-inc148-dom-");
  await seed(fixture);
  const page = await loadExecutedDom(fixture, env);
  page.workspace = fixture.workspace;
  page.deviceEnv = fixture.deviceEnv;
  page.fixture = fixture;
  page.cleanup = async () => {
    await page.waitForSettled();
    const exited = new Promise((resolveExit) => {
      if (page.child.exitCode !== null || page.child.signalCode !== null) resolveExit();
      else page.child.once("exit", resolveExit);
    });
    if (page.child.exitCode === null && page.child.signalCode === null) page.child.kill();
    await exited;
    await rm(fixture.base, { recursive: true, force: true });
  };
  page.document.querySelector('[data-page-target="settings"]')?.click();
  page.document.querySelector('[data-setting-group="execution"]')?.click();
  await new Promise((resolve) => setTimeout(resolve, 80));
  return page;
}

function assertDomContract(document) {
  assert.equal(document.querySelectorAll("template#ui-contract-markers").length, 0, "contract must inspect rendered DOM; marker template must be removed");
  const dsStyle = document.querySelector('style#tcrn-ds-component-css[data-source="snapshot"]');
  assert.ok(dsStyle, "the rendered page must inline the signed-in DS component CSS snapshot");
  const dsCss = dsStyle?.textContent ?? "";
  assert.deepEqual(
    ["tcrn-button", "tcrn-field", "tcrn-input", "tcrn-select", "tcrn-textarea", "tcrn-sr-only"].filter((name) => !dsCss.includes(`.${name}`)),
    [],
    "the six shared component roots must come from the inlined DS snapshot",
  );
  const sharedRoots = ["tcrn-button", "tcrn-field", "tcrn-input", "tcrn-select", "tcrn-textarea", "tcrn-sr-only"];
  assert.deepEqual(
    sharedRoots.filter((name) => document.querySelectorAll(`.${name}`).length === 0),
    [],
    "the executed DOM must render every shared component root",
  );
  const returnedRoots = ["tcrn-stat-card", "tcrn-setting-row", "tcrn-line-numbered-editor", "tcrn-app-status-bar"];
  const hasCssRoot = (name) => new RegExp(`\\.${name}(?=[\\s,{:>+~]|$)`, "u").test(dsCss);
  assert.deepEqual(
    returnedRoots.filter((name) => !hasCssRoot(name)),
    [],
    "the executed page must consume every returned construct from the inlined DS snapshot",
  );
  assert.deepEqual(
    returnedRoots.filter((name) => document.querySelectorAll(`.${name}`).length === 0),
    [],
    "the executed DOM must render every returned DS construct",
  );
  const alignedSelectors = [
    ["product shell", ".tcrn-product-shell"],
    ["top bar", "header.tcrn-top-bar"],
    // INC-167: the brand is the design system's shell lockup and it sits in the sidebar
    // header, which is where the product shell defines __brand as a child. INIT-053 R45 (U15):
    // ProductShell renders __brand as the home link, so the construct is an anchor.
    ["brand lockup", "a.tcrn-product-shell__brand.tcrn-shell-brand-lockup[href]"],
    ["sidebar header", ".tcrn-product-shell__sidebar .tcrn-product-shell__sidebar-header"],
    ["brand mark", 'img.tcrn-brand-mark[data-brand-asset="tcrn-brand-mark"]'],
    ["side navigation", ".tcrn-side-nav"],
    // INC-168 selection-level invariants. The shell controls are the design system's
    // own, not generic parts assembled to look like them: a quiet button wearing a
    // "Theme" label and a bare <select> for language both passed every earlier gate
    // while being the wrong components. Each entry here names the construct the
    // storybook publishes for that role.
    ["shell theme toggle", "button.tcrn-shell-theme-toggle"],
    ["shell locale menu", ".tcrn-shell-locale-menu > .tcrn-shell-locale-menu__trigger"],
    ["locale menu panel", '.tcrn-shell-locale-menu__panel[role="listbox"]'],
    ["compound search input", "span.tcrn-search-input > input.tcrn-search-input__control"],
    ["search shortcut", "kbd.tcrn-search-input__shortcut"],
    ["workspace section tabs", '[data-ui="workspace-tabs"].tcrn-section-tabs'],
    ["surface", ".tcrn-surface"],
    ["built-in rules list", "#prose-directory[data-ui=rule-list]"],
    ["receipt badge", "#receipt-chip.tcrn-badge"],
    ["detail drawer", "#receipt-drawer.tcrn-detail-drawer"],
    ["readback panel", "#receipt-body.tcrn-readback-panel"],
  ];
  assert.deepEqual(
    alignedSelectors.filter(([, selector]) => !document.querySelector(selector)),
    [],
    "the executed DOM must expose the S253 DS class alignment",
  );
  const missing = missingComponents(document);
  assert.deepEqual(missing, [], `rendered DOM components absent: ${JSON.stringify(missing)}`);
  const navigationItems = [...document.querySelectorAll(".tcrn-side-nav .tcrn-nav-item")];
  // STORY-370 retired Entities, STORY-403 folds article reading into knowledge,
  // STORY-485 adds the independent gate configuration destination, and TCRN-CROSS-SUB-409
  // (STORY-508 R5) gives model categories and model tiers a page each.
  assert.equal(navigationItems.length, 8, "the portal must render eight live platform destinations including model categories, model tiers, custom variables and gate configuration");
  assert.deepEqual(navigationItems.map((button) => button.getAttribute("data-page-target")), ["dashboard", "settings", "model-categories", "model-tiers", "variables", "prose", "vocabulary", "gates"]);
  assert.ok(navigationItems.every((button) => button.getAttribute("aria-label")?.trim()), "every destination must expose an accessible name");
  assert.ok(navigationItems.every((button) => button.getAttribute("data-i18n-aria-label")?.trim()), "every destination name must come from the locale table");
  assert.equal(document.querySelector('img.tcrn-brand-mark')?.getAttribute("alt"), "", "the decorative mark must not duplicate the brand accessible name");
  assert.ok(document.querySelector('[data-ui="receipt-chip"][data-ui-action="open-receipt"]'), "receipt chip must expose its action");
}

async function assertBehaviorContract(page) {
  const { document, window } = page;
  const chip = document.querySelector('[data-ui="receipt-chip"]');
  const drawer = document.querySelector('[data-ui="receipt-drawer"]');
  chip.click();
  assert.equal(drawer.dataset.open, "true", "receipt chip click must open the drawer");
  assert.equal(drawer.getAttribute("aria-hidden"), "false", "receipt drawer must expose its open state");
  document.querySelector("#drawer-close").click();
  const beforeSetting = receiptText(document);
  const control = document.querySelector('#settings-rows [data-setting-control]');
  assert.ok(control, "fixture must expose a settings control for the write leg");
  if (control.tagName === "BUTTON") control.click();
  else {
    if (control.tagName === "SELECT") control.value = control.value;
    control.dispatchEvent(new window.Event("change", { bubbles: true }));
  }
  await waitFor(receiptAdvanced(document, beforeSetting), "the receipt chip to advance after the settings write");
  const chipText = document.querySelector("#receipt-chip-text").textContent;
  assert.match(chipText, /^✓v\d+$/u, `receipt chip must update after a successful write, got ${JSON.stringify(chipText)}`);
}

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
} else {
  test("INC-148 rendered DOM contract names every preview component", async () => {
    const page = await preparePage();
    try { assertDomContract(page.document); } finally { await page.cleanup(); }
  });

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
      const knowledge = dashboardList.querySelector('[data-workspace-tab="knowledge"]');
      assert.equal(knowledge.getAttribute("aria-selected"), "true", "dashboard End selects the final panel");
      assert.equal(page.document.querySelector('[data-workspace-panel="knowledge"]').hidden, false);
      keydown(knowledge, "Home");
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

  test("INC-183 every live enum setting is its own dictionary entry", async () => {
    const page = await preparePage();
    try {
      const navFor = (category) => page.document.querySelector(`[data-vocabulary-category="${category}"]`);
      assert.equal(navFor("settingsEnums"), null, "the retired shared settings-enum domain must not appear");
      assert.equal(page.document.querySelector('[data-vocabulary-table="settingsEnums"]'), null);
      const entries = [...page.document.querySelectorAll("[data-vocabulary-category]")]
        .map((button) => button.dataset.vocabularyCategory)
        .filter((category) => category.startsWith("setting:"));
      assert.deepEqual(entries, ["setting:artifact.language"], "only the live closed-enum setting belongs in the vocabulary");
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
          assert.equal(row.dataset.settingShape, expected[index].shape, `${expected[index].key} keeps its shape`);
          assert.equal(row.hasAttribute("data-machine-row"), expected[index].layer === "device", `${expected[index].key} is written through its own layer`);
        }
        assert.ok(page.document.querySelector("#settings-count")?.textContent.startsWith(`${expected.length} `), `${group} counts its keys`);
        assert.equal(rows.some((row) => row.key === retiredEconomySettingKey), false);
        assert.equal(page.document.querySelector(`[data-setting-row="${retiredEconomySettingKey}"]`), null, `the retired economy-tier model stays out of ${group}`);
      }

      // The models group lists its two collections as links to their pages, never as editors.
      page.document.querySelector('[data-setting-group="models"]')?.click();
      for (const [key, target] of [["models.category", "model-categories"], ["models.tiers", "model-tiers"]]) {
        const row = page.document.querySelector(`[data-setting-row="${key}"]`);
        assert.equal(row?.dataset.settingShape, "collection");
        assert.equal(row.querySelector("[data-setting-control], [data-collection-field]"), null, `${key} has no editor on the settings page`);
        row.querySelector(`[data-collection-link="${target}"]`).click();
        assert.equal(page.document.querySelector(`[data-page="${target}"]`)?.hidden, false, `${key} opens its own page`);
        page.document.querySelector('[data-page-target="settings"]')?.click();
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

      page.document.querySelector('[data-setting-group="models"]')?.click();
      const ceiling = page.document.querySelector('[data-setting-control="models.escalation.ceiling"]');
      assert.equal(ceiling?.tagName, "SELECT", "the category reference cannot fall back to free text");
      assert.equal(ceiling.closest('[data-setting-choice-component]').dataset.settingChoiceSource, "models.category");
      assert.deepEqual([...ceiling.querySelectorAll('option:not([data-reference-missing])')].map((option) => option.value), JSON.parse(project.find((entry) => entry.key === "models.category").currentValue).map((category) => category.id), "the actual category mother supplies every candidate");

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

  // TCRN-CROSS-SUB-409 (TCRN-CROSS-STORY-508 R6; contract C-R14-6): model categories and model tiers are
  // pages of their own, each one table component led by its order column under a header that says what
  // the order is for. The tier table's category column chooses from the category table and links to
  // it; each category counts its tiers and links to them. This replaces SUB-342's host-by-tier table.
  test("SUB-409 (STORY-508 R6): model categories and model tiers are two linked pages, each a table led by its order column", async () => {
    const page = await preparePage();
    try {
      const catalog = (await cli(["settings-catalog", "--workspace", page.workspace], page.deviceEnv)).settings;
      const stored = (key) => JSON.parse(catalog.find((entry) => entry.key === key).currentValue);
      const categories = stored("models.category");
      const tiers = stored("models.tiers");
      const table = (key) => page.document.querySelector(`[data-collection-table="${key}"]`);
      const columns = (key) => [...table(key).querySelectorAll("[data-collection-column]")].map((column) => column.dataset.collectionColumn);
      assert.deepEqual(columns("models.category"), ["order", "id", "name", "description", "tiers", "actions"]);
      assert.deepEqual(columns("models.tiers"), ["order", "category", "runner", "model", "effort", "note", "actions"]);
      for (const key of ["models.category", "models.tiers"]) {
        assert.equal(table(key).getAttribute("data-collection-component"), "CollectionTable", `${key} uses the one table component`);
        assert.equal(table(key).getAttribute("data-collection-columns"), String(columns(key).length));
        assert.ok(page.document.querySelector(`[data-collection-save="${key}"][data-cli-action="settings-set"]`), `${key} is written whole through settings-set`);
      }
      // The rows are the stored records in order, each order in a NumberInput.
      const orders = (key) => [...table(key).querySelectorAll('[data-collection-row] [data-collection-field="order"]')].map((input) => Number(input.value));
      assert.deepEqual(orders("models.category"), categories.map((category) => category.order));
      assert.deepEqual(orders("models.tiers"), tiers.map((tier) => tier.order));
      assert.ok([...page.document.querySelectorAll('[data-collection-table] [data-collection-field="order"]')].every((input) => input.getAttribute("data-number-input-component") === "NumberInput" && input.type === "number" && input.getAttribute("min") === "1"));
      // The category column is a choice of the category ids, set to each tier's category.
      const choices = [...table("models.tiers").querySelectorAll('select[data-collection-field="category"]')];
      assert.equal(choices.length, tiers.length);
      for (const [index, select] of choices.entries()) {
        assert.deepEqual([...select.querySelectorAll("option")].map((option) => option.getAttribute("value")), categories.map((category) => category.id));
        assert.equal(select.value, tiers[index].category);
      }
      // Each category counts the tiers filed under it, and the count opens them on the tier page.
      for (const category of categories) {
        const count = tiers.filter((tier) => tier.category === category.id).length;
        assert.equal(table("models.category").querySelector(`[data-model-category-tiers="${category.id}"]`)?.dataset.modelCategoryTierCount, String(count), `${category.id} counts its tiers`);
      }
      table("models.category").querySelector('[data-model-category-tiers="economy"]').click();
      assert.equal(page.document.querySelector('[data-page="model-tiers"]').hidden, false, "a tier count opens the tier page");
      const marked = (key, field) => [...table(key).querySelectorAll('[data-collection-row][data-transient-target="true"]')].map((row) => row.querySelector(`[data-collection-field="${field}"]`).value);
      assert.deepEqual(marked("models.tiers", "category"), tiers.filter((tier) => tier.category === "economy").map((tier) => tier.category), "and marks that category's tiers");
      // A tier's category links to its category on the category page.
      table("models.tiers").querySelector('[data-collection-row="0"] [data-model-category-link]').click();
      assert.equal(page.document.querySelector('[data-page="model-categories"]').hidden, false, "a tier's category link opens the category page");
      assert.deepEqual(marked("models.category", "id"), [tiers[0].category]);
      page.document.querySelector('[data-page-target="model-categories"]').click();
      assert.equal(page.document.querySelectorAll('[data-transient-target="true"]').length, 0, "navigation clears transient target markers");
      // Each page also links to the other from its head.
      page.document.querySelector('[data-collection-view="models.category"] [data-collection-links] [data-collection-link="model-tiers"]').click();
      assert.equal(page.document.querySelector('[data-page="model-tiers"]').hidden, false);
      page.document.querySelector('[data-collection-view="models.tiers"] [data-collection-links] [data-collection-link="model-categories"]').click();
      assert.equal(page.document.querySelector('[data-page="model-categories"]').hidden, false);
      // Both pages are project level, and say so.
      for (const key of ["models.category", "models.tiers"]) assert.equal(page.document.querySelector(`[data-collection-view="${key}"] [data-setting-layer]`)?.dataset.settingLayer, "project");

      // Five languages: each page is named, its header says what the order is for, and its table
      // and its order column carry their names.
      const expected = {
        en: ["Model categories", "Model tiers", "Order"],
        "zh-CN": ["模型分类", "模型档位", "顺序"],
        ja: ["モデル分類", "モデルティア", "順序"],
        ko: ["모델 분류", "모델 티어", "순서"],
        fr: ["Catégories de modèles", "Niveaux de modèle", "Ordre"],
      };
      for (const [locale, [categoriesName, tiersName, orderName]] of Object.entries(expected)) {
        page.document.querySelector(`[data-locale-option="${locale}"]`)?.click();
        assert.equal(page.document.querySelector('[data-page-target="model-categories"] .tcrn-nav-item__label').textContent, categoriesName);
        assert.equal(page.document.querySelector('[data-page-target="model-tiers"] .tcrn-nav-item__label').textContent, tiersName);
        assert.equal(page.document.querySelector('[data-page="model-categories"] h1').textContent, categoriesName);
        assert.equal(page.document.querySelector('[data-page="model-tiers"] h1').textContent, tiersName);
        for (const [key, lede] of [["models.category", "modelCategories.lede"], ["models.tiers", "modelTiers.lede"]]) {
          const purpose = page.document.querySelector(`[data-collection-purpose="${key}"]`).textContent;
          assert.ok(purpose !== lede && purpose.toLocaleLowerCase().includes(orderName.toLocaleLowerCase()), `${locale} ${key}: the header says what the order is for`);
          assert.equal(table(key).querySelector('[data-collection-column="order"]').textContent, orderName);
          assert.ok(!table(key).getAttribute("aria-label").includes("."), `${locale} ${key}: the table is named`);
        }
      }
      page.document.querySelector('[data-locale-option="en"]')?.click();
      // The Rules page's save names the verb it calls since TCRN-CROSS-SUB-338: rule-list, not agents-render.
      assert.equal(page.document.querySelector("#save-agents").getAttribute("data-cli-action"), "rule-list");
      assert.doesNotMatch(page.source, /agents-render/u);
    } finally { await page.cleanup(); }
  });

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

  // TCRN-CROSS-SUB-409 (TCRN-CROSS-STORY-508 R6; contracts C-R14-2, C-R14-6): the tier table is written
  // whole and read back. A refused table stays on the page as it was sent, with the engine's reason code
  // on each row it names (a repeated order, a category the category table lacks), and a record the
  // system variables render withholds says so on its row. This replaces SUB-342's host-by-tier editor.
  test("SUB-409 (STORY-508 R6): the tier table is saved whole, and each refused or withheld row shows its reason code", async () => {
    const page = await preparePage();
    try {
      const stored = async (key) => JSON.parse((await cli(["settings-catalog", "--workspace", page.workspace], page.deviceEnv)).settings.find((entry) => entry.key === key).currentValue);
      const agents = () => readFile(join(page.fixture.proseRoot, "AGENTS.md"), "utf8");
      const original = await stored("models.tiers");
      const table = () => page.document.querySelector('[data-collection-table="models.tiers"]');
      const field = (index, name) => table().querySelector(`[data-collection-row="${index}"] [data-collection-field="${name}"]`);
      const findings = () => [...table().querySelectorAll("[data-collection-finding]")].map((node) => [node.closest("[data-collection-finding-row]").dataset.collectionFindingRow, node.dataset.collectionFinding]);
      // A save is one request and, when it lands, the reads that follow it; the page settles after all of them.
      const save = async () => {
        page.document.querySelector('[data-collection-save="models.tiers"]').click();
        await page.waitForSettled();
        return receiptText(page.document);
      };
      page.document.querySelector('[data-page-target="model-tiers"]').click();

      // A new row takes the next order in steps of ten; filled in and saved, it reads back and renders.
      page.document.querySelector('[data-collection-add="models.tiers"]').click();
      const added = original.length;
      const order = original.at(-1).order + 10;
      assert.equal(field(added, "order").value, String(order));
      field(added, "category").value = "economy";
      field(added, "runner").value = "claude-code";
      field(added, "model").value = "test-model";
      field(added, "effort").value = "high";
      field(added, "note").value = "portal";
      assert.match(await save(), /^✓v\d+$/u);
      const written = await stored("models.tiers");
      assert.deepEqual(written.at(-1), { order, category: "economy", runner: "claude-code", model: "test-model", effort: "high", note: "portal" });
      assert.match(await agents(), new RegExp(`\\| ${order} \\| economy \\| claude-code \\| test-model \\| high \\| portal \\|`, "u"));
      assert.equal(table().querySelectorAll("[data-collection-row]").length, written.length);

      // A repeated order is refused: both rows that share it carry the code, the table stays as sent,
      // and nothing is written.
      field(1, "order").value = field(0, "order").value;
      assert.match(await save(), /^✕/u);
      assert.deepEqual(findings(), [["0", "MODELS_ORDER_DUPLICATE"], ["1", "MODELS_ORDER_DUPLICATE"]]);
      for (const index of [0, 1]) assert.equal(field(index, "order").getAttribute("aria-invalid"), "true");
      assert.equal(field(1, "order").value, String(written[0].order), "the refused table stays on the page as it was sent");
      assert.deepEqual(await stored("models.tiers"), written, "a refused table writes nothing");

      // A tier naming a category the category table lacks is refused on its row.
      field(1, "order").value = String(written[1].order);
      const category = field(2, "category");
      const ghost = page.document.createElement("option");
      ghost.setAttribute("value", "ghost");
      category.append(ghost);
      category.value = "ghost";
      assert.match(await save(), /^✕/u);
      assert.deepEqual(findings(), [["2", "MODELS_CATEGORY_UNKNOWN"]]);
      assert.equal(field(2, "category").getAttribute("aria-invalid"), "true");
      assert.equal(field(2, "category").value, "ghost", "the row keeps the category it was sent with");
      assert.deepEqual(await stored("models.tiers"), written);

      // A note shaped like a credential is stored but withheld from AGENTS.md, and its row says so.
      field(2, "category").value = written[2].category;
      field(3, "note").value = "sk-proj-0123456789abcdef";
      assert.match(await save(), /^✓v\d+$/u);
      assert.deepEqual(findings(), [["3", "secret-shaped"]]);
      assert.equal(table().querySelector('[data-collection-finding="secret-shaped"]').className.includes("tcrn-inline-alert--warning"), true, "a withheld record is a warning, not a refusal");
      const rendered = await agents();
      assert.match(rendered, new RegExp(`\\| ${written[3].order} \\| ${written[3].category} \\| ${written[3].runner} \\| \\(withheld\\) \\| \\(withheld\\) \\| \\(withheld\\) \\|`, "u"));
      assert.doesNotMatch(rendered, /sk-proj-0123456789abcdef/u);

      // Removing a row and saving drops its record.
      table().querySelector(`[data-collection-remove="${added}"]`).click();
      assert.equal(table().querySelectorAll("[data-collection-row]").length, original.length);
      assert.match(await save(), /^✓v\d+$/u);
      assert.equal((await stored("models.tiers")).some((tier) => tier.order === order), false);

      // Restoring the default table puts the default records back, and the withheld note with them goes.
      const reset = page.document.querySelector('[data-collection-reset="models.tiers"]');
      assert.ok(reset, "a table that differs from the default can be restored");
      reset.click();
      await page.waitForSettled();
      assert.match(receiptText(page.document), /^✓v\d+$/u);
      assert.deepEqual(await stored("models.tiers"), original);
      assert.deepEqual([...table().querySelectorAll('[data-collection-row] [data-collection-field="order"]')].map((input) => Number(input.value)), original.map((tier) => tier.order));
      assert.deepEqual(findings(), []);
      assert.equal(page.document.querySelector('[data-collection-reset="models.tiers"]'), null, "the default table offers no restore");
      assert.doesNotMatch(await agents(), /\(withheld\)/u);
    } finally { await page.cleanup(); }
  });

  // TCRN-CROSS-SUB-409 (TCRN-CROSS-STORY-508 R1, R6): a category is added on its page and offered to the
  // tiers at once; a repeated id is refused on both rows, and a category that tiers are still filed under
  // cannot be dropped: the refusal names the tier records that keep it.
  test("SUB-409 (STORY-508 R1, R6): the category table is saved whole; a repeated id and a category still in use are refused on the page", async () => {
    const page = await preparePage();
    try {
      const stored = async (key) => JSON.parse((await cli(["settings-catalog", "--workspace", page.workspace], page.deviceEnv)).settings.find((entry) => entry.key === key).currentValue);
      const table = (key) => page.document.querySelector(`[data-collection-table="${key}"]`);
      const field = (key, index, name) => table(key).querySelector(`[data-collection-row="${index}"] [data-collection-field="${name}"]`);
      for (const input of page.document.querySelectorAll('[data-collection-field]')) {
        assert.equal(input.getAttribute("aria-label"), input.closest('[role="cell"]').getAttribute("data-label"));
        assert.ok(input.getAttribute("aria-label"));
      }
      // Typing sends the input event a reader's typing would, so the page's draft keeps the edit.
      const type = (input, value) => { input.value = value; input.dispatchEvent(new page.window.Event("input", { bubbles: true })); };
      const save = async (key) => {
        page.document.querySelector(`[data-collection-save="${key}"]`).click();
        await page.waitForSettled();
        return receiptText(page.document);
      };
      const original = await stored("models.category");
      page.document.querySelector('[data-page-target="model-categories"]').click();

      page.document.querySelector('[data-collection-add="models.category"]').click();
      assert.equal(field("models.category", original.length, "order").value, String(original.at(-1).order + 10));
      type(field("models.category", original.length, "order"), "25");
      type(field("models.category", original.length, "id"), "review");
      type(field("models.category", original.length, "name"), "Review");
      type(field("models.category", original.length, "description"), "A second look");
      assert.match(await save("models.category"), /^✓v\d+$/u);
      const categories = await stored("models.category");
      assert.deepEqual(categories.map((entry) => [entry.order, entry.id]), [[10, "flagship"], [20, "main"], [25, "review"], [30, "economy"]]);
      assert.deepEqual(categories[2], { order: 25, id: "review", name: "Review", description: "A second look" });
      assert.equal(field("models.category", 2, "id").value, "review", "the page reads the table back in its order");
      assert.equal(table("models.category").querySelector('[data-collection-row="2"] [data-model-category-tier-count]')?.dataset.modelCategoryTierCount, "0");
      const offered = [...table("models.tiers").querySelector('[data-collection-row="0"] select[data-collection-field="category"]').querySelectorAll("option")].map((option) => option.getAttribute("value"));
      assert.deepEqual(offered, ["flagship", "main", "review", "economy"], "the tier page offers the new category at once");

      // A repeated id is refused on both rows that carry it.
      type(field("models.category", 2, "id"), "main");
      assert.match(await save("models.category"), /^✕/u);
      assert.deepEqual([...table("models.category").querySelectorAll("[data-collection-finding]")].map((node) => [node.closest("[data-collection-finding-row]").dataset.collectionFindingRow, node.dataset.collectionFinding, node.dataset.collectionFindingField]), [["1", "MODELS_CATEGORY_DUPLICATE", "id"], ["2", "MODELS_CATEGORY_DUPLICATE", "id"]]);
      assert.deepEqual(await stored("models.category"), categories);
      type(field("models.category", 2, "id"), "review");

      // File a tier under the new category, then try to drop it: the refusal names the tier.
      page.document.querySelector('[data-page-target="model-tiers"]').click();
      const tierCategory = field("models.tiers", 0, "category");
      tierCategory.value = "review";
      tierCategory.dispatchEvent(new page.window.Event("change", { bubbles: true }));
      const tierOrder = Number(field("models.tiers", 0, "order").value);
      assert.match(await save("models.tiers"), /^✓v\d+$/u);
      assert.equal((await stored("models.tiers")).find((tier) => tier.order === tierOrder)?.category, "review");
      page.document.querySelector('[data-page-target="model-categories"]').click();
      assert.equal(field("models.category", 2, "id").value, "review", "the category page kept its unsaved edit across the tier write");
      assert.equal(table("models.category").querySelector('[data-model-category-tiers="review"]')?.dataset.modelCategoryTierCount, "1");
      table("models.category").querySelector('[data-collection-remove="2"]').click();
      assert.match(await save("models.category"), /^✕/u);
      const inUse = page.document.querySelector('[data-collection-alerts="models.category"] [data-collection-finding="MODELS_CATEGORY_IN_USE"]');
      assert.ok(inUse, "a category still in use is refused above the table, since its row is the one removed");
      assert.match(inUse.textContent, new RegExp(`review: models\\.tiers\\.${tierOrder}`, "u"));
      assert.deepEqual(await stored("models.category"), categories, "the refused table writes nothing");
    } finally { await page.cleanup(); }
  });

  // TCRN-CROSS-SUB-409 (TCRN-CROSS-STORY-508 R6): an empty table says what to do first, with the control
  // that does it, and keeps its order column; a tier table with no category to file under sends the
  // reader to the category page. TCRN-CROSS-SUB-406 (R3): a write may not drop the category the
  // escalation ceiling names, so only a merge leaves the category table empty (the fixture records it as
  // replay reads a merged value), and emptying it on the page is refused with the ceiling named.
  test("SUB-409 (STORY-508 R6): an empty table guides the reader to its first record", async () => {
    const fixture = await scratch("tcrn-409-empty-");
    const atelier = { ...fixture.deviceEnv, EINZBERN_SURFACE: "atelier" };
    // The tiers go first: a category that tiers are filed under cannot be dropped.
    await cli(["settings-set", "--workspace", fixture.workspace, "--at", nextAt(), "--actor", "agent:test", "--key", "models.tiers", "--value", "[]"], atelier);
    await mergedSetting(fixture, "models.category", "[]");
    const page = await loadExecutedDom(fixture);
    try {
      for (const key of ["models.category", "models.tiers"]) {
        assert.equal(page.document.querySelectorAll(`[data-collection-table="${key}"] [data-collection-row]`).length, 0);
        assert.ok(page.document.querySelector(`[data-collection-table="${key}"] [data-collection-column="order"]`), `${key} keeps its order column when empty`);
        assert.ok(page.document.querySelector(`[data-collection-empty="${key}"] .tcrn-state-surface__title`)?.textContent.trim(), `${key} says it is empty`);
      }
      const categoriesGuide = page.document.querySelector('[data-collection-empty="models.category"]');
      assert.ok(categoriesGuide.querySelector('[data-collection-add="models.category"]'), "an empty category table offers to add one");
      const tiersGuide = page.document.querySelector('[data-collection-empty="models.tiers"]');
      assert.equal(tiersGuide.querySelector("[data-collection-add]"), null, "a tier cannot be added before a category exists");
      tiersGuide.querySelector('[data-collection-link="model-categories"]').click();
      assert.equal(page.document.querySelector('[data-page="model-categories"]').hidden, false, "the tier table's guide opens the category page");
      page.document.querySelector('[data-collection-empty="models.category"] [data-collection-add="models.category"]').click();
      const first = page.document.querySelector('[data-collection-table="models.category"] [data-collection-row="0"] [data-collection-field="order"]');
      assert.equal(first?.value, "10", "the first category takes the first order");
      page.document.querySelector('[data-page-target="settings"]').click();
      page.document.querySelector('[data-setting-group="models"]').click();
      for (const key of ["models.category", "models.tiers"]) assert.equal(page.document.querySelector(`[data-setting-row="${key}"] [data-collection-count]`)?.textContent, "0 records");
      for (const locale of ["en", "zh-CN", "ja", "ko", "fr"]) {
        page.document.querySelector(`[data-locale-option="${locale}"]`)?.click();
        const guide = page.document.querySelector('[data-collection-empty="models.tiers"]');
        assert.ok([...guide.querySelectorAll(".tcrn-state-surface__title, .tcrn-state-surface__description")].every((node) => node.textContent.trim() && !node.textContent.startsWith("modelTiers.")), `${locale} guides the reader`);
      }
      // The first category is main, so the ceiling (main while unset) names a category again; emptying
      // the table on the page shows its guide, and saving it is refused with the ceiling named above it.
      page.document.querySelector('[data-locale-option="en"]')?.click();
      page.document.querySelector('[data-page-target="model-categories"]').click();
      for (const [name, value] of [["id", "main"], ["name", "Main"]]) {
        const input = page.document.querySelector(`[data-collection-table="models.category"] [data-collection-row="0"] [data-collection-field="${name}"]`);
        input.value = value;
        input.dispatchEvent(new page.window.Event("input", { bubbles: true }));
      }
      const saveCategories = async () => {
        page.document.querySelector('[data-collection-save="models.category"]').click();
        await page.waitForSettled();
        return receiptText(page.document);
      };
      assert.match(await saveCategories(), /^✓v\d+$/u);
      page.document.querySelector('[data-collection-table="models.category"] [data-collection-remove="0"]').click();
      assert.ok(page.document.querySelector('[data-collection-empty="models.category"]'), "the emptied table shows its guide before it is saved");
      assert.match(await saveCategories(), /^✕/u);
      const inUse = page.document.querySelector('[data-collection-alerts="models.category"] [data-collection-finding="MODELS_CATEGORY_IN_USE"]');
      assert.match(inUse?.textContent ?? "", /main: models\.escalation\.ceiling/u, "the refusal names the ceiling that keeps the category");
      const stored = JSON.parse((await cli(["settings-catalog", "--workspace", fixture.workspace], fixture.deviceEnv)).settings.find((entry) => entry.key === "models.category").currentValue);
      assert.deepEqual(stored.map((entry) => entry.id), ["main"], "the refused table writes nothing");
    } finally { page.child.kill(); await rm(fixture.base, { recursive: true, force: true }); }
  });

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

  // TCRN-CROSS-SUB-410 (TCRN-CROSS-STORY-508 R7; contract C-R14-5): the variables, rules and gates pages
  // each carry an order in the same NumberInput, under a header that says what it orders: the render
  // order of AGENTS.md for variables and rules, the plan and display order for gates. Each lists its
  // records in that order, and an order changed on the page is written by the engine and read back.
  test("SUB-410 (STORY-508 R7): variables, rules and gates each show their order, say what it orders, and write it through the engine", async () => {
    const fixture = await scratch("tcrn-410-orders-");
    const atelier = { ...fixture.deviceEnv, EINZBERN_SURFACE: "atelier" };
    const write = (command, args) => cli([command, "--workspace", fixture.workspace, "--at", nextAt(), "--actor", "agent:test", ...args], atelier);
    await write("variable-set", ["--name", "alpha", "--type", "string", "--value", "a"]);
    await write("variable-set", ["--name", "beta", "--type", "string", "--value", "b", "--order", "5"]);
    await write("gates-config-set", ["--name", "lint", "--command", JSON.stringify(["node", "--version"])]);
    await write("gates-config-set", ["--name", "unit", "--command", JSON.stringify(["node", "--version"]), "--order", "4"]);
    for (const [id, order] of [["batch", ["--order", "3"]], ["autonomy", []]]) {
      await cli(["rule-enable", "--project", fixture.proseRoot, "--id", id, ...order, "--at", nextAt(), "--actor", "agent:test"], atelier);
    }
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
      assert.deepEqual(ruleCards(), [["batch", "3"], ["autonomy", ""], ["unattended-commands", ""], ["silent-reporting", ""], ["design-authority", ""]]);
      const orderInputs = [...document.querySelectorAll('[data-variable-row] [data-variable-field="order"], [data-gate-row] [data-gate-order], [data-rule-card] [data-rule-order]')];
      assert.ok(orderInputs.length === 9 && orderInputs.every((input) => input.getAttribute("data-number-input-component") === "NumberInput" && input.type === "number" && input.getAttribute("min") === "1"));
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
      assert.deepEqual(ruleCards(), [["autonomy", "1"], ["silent-reporting", "2"], ["batch", "3"], ["unattended-commands", ""], ["design-authority", ""]]);
      const listed = (await cli(["rule-list", "--project", fixture.proseRoot], fixture.deviceEnv)).rules;
      assert.deepEqual(listed.filter((rule) => rule.order !== undefined).map((rule) => [rule.id, rule.state, rule.order]), [["autonomy", "enabled", 1], ["batch", "enabled", 3], ["silent-reporting", "enabled", 2]]);
      const text = await agents();
      assert.ok(text.indexOf("rule:autonomy") < text.indexOf("rule:silent-reporting") && text.indexOf("rule:silent-reporting") < text.indexOf("rule:batch"), "a rule switched on with an order takes its place");
    } finally { page.child.kill(); await rm(fixture.base, { recursive: true, force: true }); }
  });

  // TCRN-CROSS-SUB-410 (TCRN-CROSS-STORY-508 R6; contract C-R14-3): the top of the tier page shows the
  // three escalation settings as they stand, read only, and links to the settings group where they are
  // changed; a change made there shows on the tier page.
  test("SUB-410 (STORY-508 R6): the tier page shows the escalation settings read only and links to their settings group", async () => {
    const page = await preparePage();
    try {
      const document = page.document;
      document.querySelector('[data-page-target="model-tiers"]').click();
      const view = document.querySelector('[data-collection-view="models.tiers"]');
      const summary = () => view.querySelector(":scope > [data-escalation-summary]");
      assert.equal(view.firstElementChild, summary(), "the summary heads the tier page");
      const shown = () => Object.fromEntries([...summary().querySelectorAll("[data-escalation-value]")].map((node) => [node.dataset.escalationValue, node.textContent]));
      assert.deepEqual(shown(), { "models.escalation.enabled": "enabled", "models.escalation.threshold": "1", "models.escalation.ceiling": "main" });
      assert.equal(summary().querySelectorAll("input, select, textarea").length, 0, "the summary is read only");
      const keys = ["models.escalation.enabled", "models.escalation.threshold", "models.escalation.ceiling"];
      for (const locale of ["en", "zh-CN", "ja", "ko", "fr"]) {
        document.querySelector(`[data-locale-option="${locale}"]`)?.click();
        const labels = [...summary().querySelectorAll("[data-escalation-key] > span:first-child")].map((node) => node.textContent.trim());
        assert.ok(labels.length === 3 && labels.every((label) => label !== "" && !label.startsWith("setting.")), `${locale} names the three settings`);
        assert.ok(!summary().querySelector("h2").textContent.startsWith("modelTiers."), `${locale} names the summary`);
      }
      document.querySelector('[data-locale-option="en"]')?.click();

      // The link opens the settings group that holds the three keys, and a change there shows here.
      summary().querySelector("[data-escalation-settings-link]").click();
      assert.equal(document.querySelector('[data-page="settings"]').hidden, false);
      assert.equal(document.querySelector('[data-settings-layout-nav] [data-setting-group="models"]').getAttribute("aria-selected"), "true");
      for (const key of keys) assert.ok(document.querySelector(`[data-setting-row="${key}"]`), `${key} is in the group`);
      const before = receiptText(document);
      const threshold = document.querySelector('[data-setting-control="models.escalation.threshold"]');
      threshold.value = "3";
      threshold.dispatchEvent(new page.window.Event("change", { bubbles: true }));
      await waitFor(() => receiptAdvanced(document, before)(), "the threshold write receipt");
      await page.waitForSettled();
      document.querySelector('[data-page-target="model-tiers"]').click();
      assert.equal(shown()["models.escalation.threshold"], "3");
    } finally { await page.cleanup(); }
  });

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
      assert.equal(panel.hidden, false, "missing project bindings are visible");
      assert.equal(panel.querySelector("[data-design-authority-state]")?.dataset.designAuthorityState, "unconfigured");

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

  // TCRN-CROSS-STORY-482 R4: the evolution panel (conflict retirements, retrieval evaluation and the
  // host render state), the session audit (its tab, its button and its list in the receipt drawer)
  // and the execution surface left with the mechanisms they showed. The page neither renders them
  // nor asks the server for them; the receipt drawer keeps the engine's receipt.
  test("STORY-482 R4: the evolution panel, the session audit and the host projection are gone from the page", async () => {
    const page = await preparePage();
    try {
      const tabs = [...page.document.querySelectorAll("[data-workspace-tab]")].map((tab) => tab.dataset.workspaceTab);
      assert.deepEqual(tabs, ["overview", "work", "knowledge"]);
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
        assert.equal(complete.error, "fetch failed");
        assert.ok(failure.querySelector(".tcrn-state-surface__description").textContent.length > 0);
      } finally { broken.child.kill(); }
    } finally { await rm(fixture.base, { recursive: true, force: true }); }
  });

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

// TCRN-CROSS-INIT-053 R45 (U12, U14): a device whose two fixture libraries and a third are project chains
// under one coordination chain, declared through the CLI on Atelier's surface as Atelier declares them.
// project-list names each project by its external key (TCRN-CROSS-INIT-053 R46 I01), so every target
// reaches the page under its own name.
async function projectChainFixture(prefix) {
  const fixture = await scratch(prefix);
  const atelier = { ...fixture.deviceEnv, EINZBERN_SURFACE: "atelier" };
  const coordination = { project: join(fixture.base, "coordination-project"), library: join(fixture.base, "coordination-library") };
  coordination.projectId = await registeredLibrary(fixture.deviceEnv, coordination.project, coordination.library, "TCRN-R45-COORDINATION");
  const third = { project: join(fixture.base, "third-project"), library: join(fixture.base, "third-library") };
  third.projectId = await registeredLibrary(fixture.deviceEnv, third.project, third.library, "TCRN-R45-THIRD");
  const libraryId = async (library) => (await cli(["status", "--workspace", library], fixture.deviceEnv)).workspaceId;
  coordination.libraryId = await libraryId(coordination.library);
  await cli(["chain-declare", "--workspace", coordination.library, "--role", "coordination", "--coordination-library-id", coordination.libraryId, "--at", nextAt()], atelier);
  coordinationLibraries.add(coordination.library);
  const targets = [];
  for (const [library, projectId] of [[fixture.workspace, fixture.projectId], [fixture.second.library, fixture.second.projectId], [third.library, third.projectId]]) {
    await cli(["chain-declare", "--workspace", library, "--role", "project", "--coordination-library-id", coordination.libraryId, "--at", nextAt()], atelier);
    targets.push({ libraryId: await libraryId(library), projectId });
  }
  return { ...fixture, atelier, coordination, third, targets };
}

const GHOST_TARGET = Object.freeze({ libraryId: `library:${"f".repeat(24)}`, projectId: `project:${"e".repeat(24)}` });
const COMPLETE_ID = /(?:library|project):[0-9a-f]{24}/u;

async function openWorkEditor(page) {
  const { document } = page;
  document.querySelector('[data-page-target="dashboard"]')?.click();
  document.querySelector('[data-workspace-tab="work"]')?.click();
  await waitFor(() => document.querySelector("#work-target-editor [data-target-save]"), "the work target editor");
  return document.querySelector("#work-target-editor");
}

// A page is closed only after its own requests settle: a read still out when the portal exits would
// fail inside the page after the case has ended.
async function closePage(page, fixture) {
  try { await page.waitForSettled(); } catch { /* the case's own assertion already failed */ }
  const exited = new Promise((resolveExit) => {
    if (page.child.exitCode !== null || page.child.signalCode !== null) resolveExit();
    else page.child.once("exit", resolveExit);
  });
  if (page.child.exitCode === null && page.child.signalCode === null) page.child.kill();
  await exited;
  await rm(fixture.base, { recursive: true, force: true });
}

function keydown(page, target, key) {
  const event = new page.window.Event("keydown", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "key", { value: key });
  target.dispatchEvent(event);
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
    assert.equal(copy.querySelector("[data-copy-label]").textContent, locales.en["copy.idle"]);
    assert.equal(copy.querySelector("[data-copy-status]").getAttribute("role"), "status");
    assert.equal(copy.querySelector("[data-copy-status]").getAttribute("aria-live"), "polite");
    assert.equal(copy.getAttribute("aria-label"), locales.en["projects.copyIdentity"].replace("{name}", expectedCandidates[1]));
    assert.doesNotMatch(copy.getAttribute("aria-label"), COMPLETE_ID, "the copy action is named without the value it copies");
    let copyFocused = 0;
    copy.focus = () => { copyFocused += 1; };
    copy.click();
    await waitFor(() => copy.getAttribute("data-clipboard-copy-state") === "unsupported", "the copy action's answer");
    assert.equal(copy.querySelector("[data-copy-status]").textContent, locales.en["copy.unsupported"]);
    assert.equal(copy.querySelector("[data-copy-label]").textContent, locales.en["copy.unsupported"]);
    assert.equal(copyFocused, 1, "focus stays on the copy action");
    await waitFor(() => copy.getAttribute("data-clipboard-copy-state") === "idle", "the copy action to return to idle", 5000);
    assert.equal(copy.querySelector("[data-copy-status]").textContent, "");
    assert.equal(copy.querySelector("[data-copy-label]").textContent, locales.en["copy.idle"]);

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
      assert.equal(localizedDetails.querySelector("[data-copy-label]").textContent, locales[locale]["copy.idle"]);
      assert.equal(localizedDetails.querySelector("dt").textContent, locales[locale]["projects.unavailable"]);
    }
  } finally { await closePage(page, fixture); }
});

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

// TCRN-CROSS-INIT-053 R46 (I10; U20 D3, receipt badge): a library switch clears what the page showed for the
// library it leaves -- the design authority panel, the receipt and the readiness result -- before the next
// library is read, so nothing of the old one is on screen while the new one loads.
if (!MUTATION) test("R46 I10: a library switch clears the design authority panel, the receipt and the readiness result before the next library is read", async () => {
  const fixture = await scratch("tcrn-r46-i10-leave-");
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

// TCRN-CROSS-INIT-053 R46 (I12; U20 D6): a child's projects stay within its parent's declared scope, as the
// engine requires. Under a Story with selected projects a Subtask can choose only those; the others are
// unavailable and say why. Under a coordination-only Story none can be chosen, nor the selected scope.
async function scopedWorkFixture(prefix) {
  const fixture = await projectChainFixture(prefix);
  const [, second, third] = fixture.targets;
  const create = async (externalKey, kind, extra) => (await cli(["work-create", "--workspace", fixture.workspace, "--project-id", fixture.projectId, "--at", nextAt(), "--external-key", externalKey, "--kind", kind, ...extra], fixture.atelier)).record;
  const initiative = await create("R46-I12-INIT", "Initiative", ["--title", "Scoped initiative", "--involved-projects", JSON.stringify({ state: "selected", targets: [second, third] })]);
  const epic = await create("R46-I12-EPIC", "Epic", ["--parent-id", initiative.id, "--title", "Scoped epic"]);
  const story = await create("R46-I12-STORY", "Story", ["--parent-id", epic.id, "--title", "Story for the second project", "--goal", "Only the second project changes.", "--acceptance", "Given the second project When the story is worked Then only it changes.", "--involved-projects", JSON.stringify({ state: "selected", targets: [second] })]);
  const subtask = await create("R46-I12-SUBTASK", "Subtask", ["--parent-id", story.id, "--title", "Subtask of the second project's story"]);
  const coordinationStory = await create("R46-I12-COORD-STORY", "Story", ["--parent-id", epic.id, "--title", "Coordination story", "--goal", "Coordination only.", "--acceptance", "Given coordination When worked Then no project changes.", "--involved-projects", JSON.stringify({ state: "coordination-only", targets: [] })]);
  const coordinationSubtask = await create("R46-I12-COORD-SUBTASK", "Subtask", ["--parent-id", coordinationStory.id, "--title", "Subtask of the coordination story"]);
  return { ...fixture, initiative, epic, story, subtask, coordinationStory, coordinationSubtask };
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

// TCRN-CROSS-INIT-053 R46 (I12; U20 D9, c1): on the coordination chain the model tables are read only and
// say why, since its catalog lists its own runtime settings only; its gate page still saves.
if (!MUTATION) test("R46 I12: the coordination chain's model pages are read only and say why, and its gate page still saves", async () => {
  const fixture = await projectChainFixture("tcrn-r46-i12-coordination-");
  const locales = await localeTable();
  const page = await loadExecutedDom(fixture);
  try {
    const { document, window } = page;
    const select = document.querySelector("#library-select");
    select.value = fixture.coordination.project;
    select.dispatchEvent(new window.Event("change", { bubbles: true }));
    await waitFor(() => document.querySelector("#rail-workspace-label").textContent === "TCRN-R45-COORDINATION", "the coordination chain");
    await page.waitForSettled();
    for (const [page_, key] of [["model-categories", "models.category"], ["model-tiers", "models.tiers"]]) {
      document.querySelector(`[data-page-target="${page_}"]`)?.click();
      const view = document.querySelector(`#${page_}-view`);
      const note = view.querySelector(`[data-collection-read-only-note="${key}"]`);
      assert.ok(note, `${key}: the page says why it is read only`);
      assert.equal(note.textContent, locales.en["collection.coordinationReadOnly"].replace("{chain}", "TCRN-R45-COORDINATION"));
      assert.equal(view.querySelectorAll("[data-collection-save], [data-collection-add], [data-collection-reset], [data-collection-remove]").length, 0, `${key}: no control that would save`);
      assert.equal(view.querySelectorAll("[data-collection-field]:not([disabled])").length, 0, `${key}: no editable field`);
    }
    assert.equal(document.querySelector("[data-escalation-summary]"), null, "no escalation settings the chain does not have");
    document.querySelector('[data-page-target="gates"]')?.click();
    assert.ok(document.querySelector('#gate-add-form button[type="submit"][data-cli-action="gates-config-set"]'), "the gate page still adds a gate");
    document.querySelector('[data-locale-option="fr"]')?.click();
    document.querySelector('[data-page-target="model-tiers"]')?.click();
    assert.equal(document.querySelector('[data-collection-read-only-note="models.tiers"]').textContent, locales.fr["collection.coordinationReadOnly"].replace("{chain}", "TCRN-R45-COORDINATION"));
  } finally { await closePage(page, fixture); }
});

// TCRN-CROSS-INIT-053 R47 (c1-B; Owner 2026-10-09, round 7): the coordination chain lists its own runtime
// settings, so its settings page saves the artifact language, and the engine records it for the whole library
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
