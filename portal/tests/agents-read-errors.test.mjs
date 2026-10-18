// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../portal.mjs", import.meta.url), "utf8");
const block = source.slice(source.indexOf("async function agentsRead(name) {"), source.indexOf("async function agentsWrite(body) {"));
const agentsReader = (read) => new Function("readFile", "ambiguousProse", "proseTarget", "currentProseRoot", `${block}\nreturn agentsRead;`)(read, () => null, () => "/project/AGENTS.md", () => "/project");

test("prose reads preserve successful content and treat only ENOENT as an empty editor", async () => {
  for (const text of ["", "# Project instructions\n"]) {
    const result = await agentsReader(async () => text)("AGENTS.md");
    assert.equal(result.status, 200);
    assert.equal(result.body.ok, true);
    assert.equal(result.body.text, text);
  }
  const absent = await agentsReader(async () => { throw Object.assign(new Error("absent"), { code: "ENOENT" }); })("AGENTS.md");
  assert.equal(absent.status, 200);
  assert.equal(absent.body.ok, true);
  assert.equal(absent.body.text, "");
});

test("prose read failures are structured and never expose private contents or filesystem errors", async () => {
  for (const code of ["EACCES", "EIO", "EISDIR", undefined]) {
    const result = await agentsReader(async () => { throw Object.assign(new Error("PRIVATE CONTENT /private/file"), { code }); })("AGENTS.md");
    assert.deepEqual(result, { status: 500, body: { ok: false, reasonCode: "PORTAL_INTERNAL_ERROR", file: "AGENTS.md", error: "Unable to read project instructions." } });
    assert.equal(Object.hasOwn(result.body, "text"), false);
  }
});

test("prose read refusal has an existing error explanation in all five supported locales", async () => {
  const window = {};
  new Function("window", await readFile(new URL("../locales.js", import.meta.url), "utf8"))(window);
  for (const locale of ["en", "zh-CN", "ja", "ko", "fr"]) {
    assert.ok(window.PORTAL_LOCALES[locale]["reason.PORTAL_INTERNAL_ERROR"]);
    assert.ok(window.PORTAL_LOCALES[locale]["receipt.failed"]);
  }
});

test("a failed prose reload shows a receipt without replacing existing editor state", async () => {
  const page = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const start = page.indexOf("  const loadAgents = async () =>");
  const end = page.indexOf("\n", start);
  const state = { agentsText: "unsaved local edits", agentsDocument: { text: "previous contents" }, rules: { previous: true } };
  const before = structuredClone(state);
  const failure = { ok: false, reasonCode: "PORTAL_INTERNAL_ERROR" };
  const receipts = [];
  const loadAgents = new Function("api", "unkept", "state", "showReceipt", "$", `${page.slice(start, end)}\nreturn loadAgents;`)(
    async (path) => path === "/api/agents-md" ? failure : { ok: true },
    () => false,
    state,
    (receipt) => receipts.push(receipt),
    () => { assert.fail("failed reload must not mutate the editor DOM"); },
  );
  await loadAgents();
  assert.deepEqual(state, before);
  assert.deepEqual(receipts, [failure]);
});

test("ambiguous prose bindings still reach the existing candidate renderer", async () => {
  const page = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const start = page.indexOf("  const loadAgents = async () =>");
  const documentResult = { ok: false, reasonCode: "PORTAL_PROJECT_BINDING_AMBIGUOUS", outputBindingStatus: "ambiguous", candidates: ["/project-one", "/project-two"] };
  const rendered = [];
  const editor = { value: "" };
  const loadAgents = new Function("api", "unkept", "state", "showReceipt", "$", "renderAgentsFile", "renderProseDirectory", "renderPending", "renderGutter", "renderReconciliation", `${page.slice(start, page.indexOf("\n", start))}\nreturn loadAgents;`)(
    async (path) => path === "/api/agents-md" ? documentResult : { ok: true },
    () => false, {}, () => assert.fail("binding ambiguity has its own renderer"), () => editor,
    (result) => rendered.push(result), () => {}, () => {}, () => {}, () => {},
  );
  await loadAgents();
  assert.deepEqual(rendered, [documentResult]);
});
