// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../index.html", import.meta.url), "utf8");
// Execute the production preference consumer and toggle handlers, without a server,
// project data, host integration, or asynchronous response manipulation.
function themePage({ stored = null, machine = "system", dark = false, media = true } = {}) {
  const listeners = new Map();
  const toggle = { dataset: {}, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, addEventListener(k, fn) { listeners.set(k, fn); } };
  const query = { matches: dark, addEventListener(k, fn) { listeners.set(`media:${k}`, fn); } };
  const saved = [];
  const document = { documentElement: { dataset: { tcrnTheme: stored ?? "light" } } };
  const context = vm.createContext({ document, window: media ? { matchMedia: () => query } : {}, BOOT: { machineDefaults: { theme: machine } }, tcrnReadPreference: () => stored, tcrnWritePreference: (...args) => saved.push(args), $: () => toggle });
  const start = source.indexOf('  const storedTheme =');
  const end = source.indexOf('  const state =', start);
  vm.runInContext(source.slice(start, end) + '\nconst state = { theme: document.documentElement.dataset.tcrnTheme };', context);
  const handlers = source.indexOf('  const applySystemTheme =');
  const handlersEnd = source.indexOf('  // Locale menu:', handlers);
  vm.runInContext(source.slice(handlers, handlersEnd), context);
  return { document, toggle, saved, click: () => listeners.get("click")(), change: (value) => { query.matches = value; listeners.get("media:change")?.(); } };
}

test("device system theme follows OS changes until an explicit browser choice", () => {
  const page = themePage({ dark: true });
  assert.equal(page.document.documentElement.dataset.tcrnTheme, "dark");
  page.change(false);
  assert.equal(page.document.documentElement.dataset.tcrnTheme, "light");
  assert.equal(page.toggle.attrs["aria-pressed"], "false");
  assert.deepEqual(page.saved, [], "OS changes do not persist a browser override");
  page.click();
  assert.deepEqual(page.saved, [["theme", "dark"]]);
  page.change(false);
  assert.equal(page.document.documentElement.dataset.tcrnTheme, "dark", "the browser choice wins");
});

test("browser and fixed machine themes take precedence over OS preference", () => {
  for (const options of [{ stored: "light", dark: true }, { machine: "light", dark: true }, { machine: "system", media: false }]) {
    const page = themePage(options);
    assert.equal(page.document.documentElement.dataset.tcrnTheme, "light");
    page.change(true);
    assert.equal(page.document.documentElement.dataset.tcrnTheme, "light");
  }
});
