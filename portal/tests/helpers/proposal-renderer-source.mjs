// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import ts from "typescript";

/** Read the real renderer declarations without depending on formatting or story comments. */
export function proposalRendererSource(html) {
  const names = ["proposalChange", "proposalTime", "proposalsMarkup"];
  const declarations = new Map(names.map((name) => [name, []]));
  const { document } = parseHTML(html);
  for (const script of document.querySelectorAll("script:not([src])")) {
    const source = ts.createSourceFile("portal.js", script.textContent, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const visit = (node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && declarations.has(node.name.text)) {
        declarations.get(node.name.text).push(node.getText(source));
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return names.map((name) => {
    const matches = declarations.get(name);
    assert.equal(matches.length, 1, `the page declares ${name} exactly once`);
    return `const ${matches[0]};`;
  }).join("\n");
}
