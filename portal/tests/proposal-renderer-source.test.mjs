// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { proposalRendererSource } from "./helpers/proposal-renderer-source.mjs";

const declarations = "const proposalChange = () => 'change', proposalTime = () => 'time'; const proposalsMarkup = () => proposalChange() + proposalTime();";

test("renderer extraction follows declarations, including multiple declarations in one statement", () => {
  const block = proposalRendererSource(`<script type="module">(() => { ${declarations} })();</script>`);
  assert.equal(new Function(`${block}\nreturn proposalsMarkup();`)(), "changetime");
});

test("comments and strings cannot impersonate a renderer declaration", () => {
  const html = `<script>// const proposalsMarkup = () => 'fake';\nconst text = 'const proposalChange = 0;'; ${declarations}</script>`;
  const block = proposalRendererSource(html);
  assert.equal(new Function(`${block}\nreturn proposalsMarkup();`)(), "changetime");
});

test("missing or duplicated declarations fail explicitly instead of selecting an unrelated block", () => {
  assert.throws(() => proposalRendererSource("<script>const proposalsMarkup = () => '';</script>"), /proposalChange exactly once/u);
  assert.throws(() => proposalRendererSource(`<script>${declarations}</script><script>const proposalsMarkup = () => '';</script>`), /proposalsMarkup exactly once/u);
});

test("the real page renderer survives indentation changes and removal of story marker comments", async () => {
  const original = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const reformatted = original.replace(/^ {2}/gmu, "\t").replace(/^\s*\/\/ Proposals[^\n]*\n/gmu, "");
  for (const html of [original, reformatted]) {
    const block = proposalRendererSource(html);
    const render = new Function("t", "esc", "ruleTitle", "state", `${block}\nreturn proposalsMarkup;`)(
      (key) => key, String, (id) => id, { locale: "en" },
    );
    assert.equal(render([], "gate"), "");
    assert.match(render([{ kind: "gate", status: "pending", key: "p", proposedAt: "2026-01-01T00:00:00Z", target: "unit" }], "gate"), /data-proposal-action="approve"/u);
  }
});
