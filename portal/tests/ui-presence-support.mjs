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
import { appendHistoricalGateCreate } from "../../tests/helpers/workspace-fixture.mjs";
import { disposablePortalFetch } from "./helpers/disposable-portal-fetch.mjs";
import { registerLibraries } from "../../tests/helpers/register-portal-libraries.mjs";

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
  const [projectId] = await registerLibraries([{ project, library, externalKey, times: [nextAt(), nextAt(), nextAt()] }], deviceEnv);
  fixtureProjectIds.set(library, projectId);
  return projectId;
}

async function scratch(prefix) {
  const base = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  // TCRN-CROSS-INC-386: the portal and every CLI it starts read and write machine settings
  // under HOME, so each fixture carries its own scratch HOME, removed with the fixture.
  const home = join(base, "home");
  await mkdir(home);
  const deviceEnv = { EINZBERN_HOME: join(base, "device", "einzbern"), HOME: home };
  const proseRoot = join(base, "project");
  const workspace = join(proseRoot, ".ether");
  // A registered key and an unregistered one in a registered namespace (the backup namespace
  // retired with TCRN-CROSS-STORY-484 R3, and reconciliation reads only registered namespaces).
  const second = { project: join(base, "second-project"), library: join(base, "second-library") };
  let projectId;
  try {
    [projectId, second.projectId] = await registerLibraries([
      { project: proseRoot, library: workspace, externalKey: "TCRN-INC148-DOM", times: [nextAt(), nextAt(), nextAt()] },
      { ...second, externalKey: "TCRN-INC148-DOM-SECOND", times: [nextAt(), nextAt(), nextAt()] },
    ], deviceEnv);
    fixtureProjectIds.set(workspace, projectId);
    fixtureProjectIds.set(second.library, second.projectId);
    await writeFile(join(proseRoot, "AGENTS.md"), "# Workspace rules\n\nretrieval.tau\nretrieval.unknown\n", "utf8");
  } catch (error) {
    await rm(base, { recursive: true, force: true });
    throw error;
  }
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
  // linkedom does not implement activeElement/focus. Model native focus identity
  // so production focus restoration is exercised instead of silently unobservable.
  let focused = window.document.body;
  Object.defineProperty(window.document, "activeElement", { configurable: true, get() { return focused?.isConnected ? focused : window.document.body; } });
  window.HTMLElement.prototype.focus = function () {
    if (this.disabled || focused === this) return;
    focused = this;
    this.dispatchEvent(new window.Event("focus"));
    this.dispatchEvent(new window.Event("focusin", { bubbles: true }));
  };
  window.HTMLElement.prototype.blur = function () { if (focused === this) focused = window.document.body; };
  const checkedState = new WeakMap();
  Object.defineProperty(window.HTMLInputElement.prototype, "checked", {
    configurable: true,
    get() { return checkedState.has(this) ? checkedState.get(this) : this.hasAttribute("checked"); },
    set(value) { checkedState.set(this, Boolean(value)); },
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

// TCRN-CROSS-STORY-526 (TCRN-CROSS-SUB-454): Atelier starts only with TCRN_PORTAL_ACTOR set; a test portal
// writes as agent:test-portal.
async function stopPortal(child, closed) {
  if (child.pid && child.exitCode === null && child.signalCode === null) child.kill();
  await closed;
}

async function startPortal(fixture, env = {}) {
  assert.ok(fixture.home, "every portal child needs the fixture scratch HOME (TCRN-CROSS-INC-386)");
  const child = spawn(process.execPath, [join(portalRoot, "portal.mjs"), "--library", fixture.workspace, "--port", "0"], {
    env: { ...process.env, TCRN_WORKFLOW_CLI: CLI, TCRN_PORTAL_ACTOR: "agent:test-portal", ...fixture.deviceEnv, ...env, HOME: fixture.home },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const closed = new Promise((resolve) => child.once("close", resolve));
  let stdout = "";
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const diagnostics = () => `exit=${child.exitCode}, signal=${child.signalCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`;
  try {
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("portal did not start")), 15000);
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        const line = stdout.split("\n").slice(0, -1).find((entry) => entry.includes("PORTAL_LISTENING"));
        if (line) {
          clearTimeout(timer);
          try { resolve(JSON.parse(line).url); } catch (error) { reject(error); }
        }
      });
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`portal exited ${code}`)); });
    });
    return { child, url, diagnostics, closed };
  } catch (error) {
    await stopPortal(child, closed);
    await rm(fixture.base, { recursive: true, force: true });
    throw new Error(`portal startup failed: ${error.message}\n${diagnostics()}`, { cause: error });
  }
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
  const instance = portal ?? await startPortal(fixture, env);
  try {
    return await executePortalDom(instance, hold);
  } catch (error) {
    // A caller cannot clean up a page that was never returned. Only the owner stops
    // the server; a failed second tab must not terminate the first tab's process.
    if (!portal) {
      await stopPortal(instance.child, instance.closed);
      await rm(fixture.base, { recursive: true, force: true });
    }
    throw new Error(`portal DOM setup failed: ${error.message}\n${instance.diagnostics?.() ?? "borrowed portal"}`, { cause: error });
  }
}

async function executePortalDom({ child, url }, hold) {
  const fetch = disposablePortalFetch();
  const nativeFetch = (input, options) => fetch(input, options).catch((error) => {
    throw new Error(`portal request ${options?.method ?? "GET"} ${new URL(input).pathname} failed: ${error.message}`, { cause: error });
  });
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
  const release = ({ error, where = () => true, keepHolding = false, limit = Infinity } = {}) => {
    if (!keepHolding) holding = () => false;
    const waiting = [];
    const remaining = [];
    for (const entry of held.splice(0)) {
      if (waiting.length < limit && where(entry.path, entry.options)) waiting.push(entry);
      else remaining.push(entry);
    }
    held.push(...remaining);
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
        assert.ok(["mountStaticMultiSelect", "mountStaticOverlayBoundary", "mountStaticClipboardCopyButton"].every((name) => names.includes(name)), "the published bridge must export both declared bindings");
        vm.runInContext(`(()=>{${linkedBridge}\n})();`, context);
        executable = executable.replace(/^\s*import \{ mountStaticMultiSelect, mountStaticOverlayBoundary, mountStaticClipboardCopyButton \} from [^;]+;\s*/u, "const { mountStaticMultiSelect, mountStaticOverlayBoundary, mountStaticClipboardCopyButton } = window;\n");
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

const hierarchyPages = Object.freeze(["dashboard", "settings", "engine-model-policy", "model-categories", "model-tiers", "variables", "gates", "prose", "vocabulary"]);
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
  let page;
  try {
    await seed(fixture);
    page = await loadExecutedDom(fixture, env);
  } catch (error) {
    await rm(fixture.base, { recursive: true, force: true });
    throw error;
  }
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
  assert.equal(navigationItems.length, 9, "the portal renders the engine host policy alongside the existing destinations");
  assert.deepEqual(navigationItems.map((button) => button.getAttribute("data-page-target")), ["dashboard", "settings", "model-categories", "model-tiers", "engine-model-policy", "variables", "prose", "vocabulary", "gates"]);
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

// Content drafting also works in an empty library: it must not wait for the
// unrelated target editor's Save button, which requires an existing work record.
async function openWorkContentEditor(page) {
  const { document } = page;
  document.querySelector('[data-page-target="dashboard"]')?.click();
  document.querySelector('[data-workspace-tab="work"]')?.click();
  await waitFor(() => document.querySelector("#work-content-editor [data-content-draft]"), "the work content editor");
  return document.querySelector("#work-content-editor");
}

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

// TCRN-CROSS-STORY-540 GWT5 (MIN-258 D3(c), which replaces MIN-245 D6; TCRN-CROSS-SUB-508): a container with a
// coordination library inside it, registered for the container, beside the fixture's two project libraries.
async function coordinationContainerFixture(prefix, registerContainer = true) {
  const fixture = await scratch(prefix);
  const container = join(fixture.base, "container");
  await mkdir(container);
  const library = join(container, ".ether");
  await cli(["init", "--workspace", library, "--at", nextAt()], fixture.deviceEnv);
  const libraryId = (await cli(["status", "--workspace", library], fixture.deviceEnv)).workspaceId;
  await cli(["chain-declare", "--workspace", library, "--role", "coordination", "--coordination-library-id", libraryId, "--at", nextAt()], { ...fixture.deviceEnv, EINZBERN_SURFACE: "atelier" });
  await cli(["library-register", "--project", registerContainer ? container : library, "--library", library, "--at", nextAt()], fixture.deviceEnv);
  coordinationLibraries.add(library);
  await writeFile(join(container, "AGENTS.md"), "# The container\n", "utf8");
  return { ...fixture, container, coordination: library, coordinationId: libraryId };
}

// PR24 U1-U4: run the served Portal and real isolated selection endpoints. Waiting
// observes completed requests, never the expected enabled state of a control.
const policySwitchViews = [
  ["engine-model-policy", "#engine-model-policy-view"],
  ["model-categories", "#model-categories-view"],
  ["model-tiers", "#model-tiers-view"],
];
function policySwitchControls(page, selector) {
  const view = () => page.document.querySelector(selector);
  const control = (name) => view().querySelector(`[data-engine-model-policy-${name}]`);
  const change = (node, value, kind = "change") => { node.value = value; node.dispatchEvent(new page.window.Event(kind, { bubbles: true })); };
  const recovered = () => {
    for (const name of ["host", "decision", "undo"]) assert.equal(control(name)?.disabled, false, `${selector}: ${name} recovers without navigation`);
    const offeredOnboarding = view().querySelector('[data-engine-model-policy-status="unconfigured"]') !== null
      && view().querySelector('[data-engine-model-policy-onboarding]') !== null;
    const writePending = control("save")?.getAttribute("aria-busy") === "true";
    assert.equal(control("save")?.disabled, writePending || !offeredOnboarding, `${selector}: only unsaved onboarding enables Save; configured pristine and pending writes remain disabled`);
  };
  return { view, control, change, recovered };
}
export { CLI, COMPLETE_ID, DS_CONTRACT, GHOST_TARGET, MUTATION, appendHistoricalGateCreate, asFixtureDevice, assert, assertBehaviorContract, assertDomContract, bridgeExports, cli, closePage, coordinationContainerFixture, expectedTargetLabels, fixtureProjectIds, join, keydown, linkBridge, loadExecutedDom, localeTable, mkdir, nextAt, openWorkContentEditor, openWorkEditor, pageHierarchyFindings, policySwitchControls, policySwitchViews, portalRoot, preparePage, projectChainFixture, readFile, receiptAdvanced, receiptText, rm, scopedWorkFixture, scratch, seed, test, topbarFindings, vm, waitFor, writeFile, writeScratch };
