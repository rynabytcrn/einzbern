// SPDX-License-Identifier: Apache-2.0
// The static count of test and assertion call sites in one test file, read by the review
// evidence (scripts/review-evidence.mjs) to compare a change's before and after. It moved
// here from coverage conservation, which is retired (TCRN-CROSS-STORY-467 R2); the counting
// rule is unchanged: parsed calls only, so fixture strings and comments are not code.

import ts from "typescript";

export function countTests(source) {
  const file = ts.createSourceFile(
    "coverage.mjs",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const tests = [];
  let assertions = 0;

  function visit(node) {
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(file);
      // Preserve the existing static call-site surface, including context.test.
      // Inspect parsed calls only; fixture strings and comments are not code.
      if (/\btest(?:\.(?:skip|only|todo))?$/u.test(callee)) {
        const name = node.arguments[0];
        if (name && (
          ts.isStringLiteral(name)
          || ts.isNoSubstitutionTemplateLiteral(name)
          || ts.isTemplateExpression(name)
        )) {
          // The AST establishes the literal boundary. Keep source spelling and
          // template placeholders, pairing the closing quote with its opener.
          const match = name.getText(file).match(/^(["'`])([\s\S]*)\1$/u);
          if (match) tests.push(match[2]);
        }
      }
      if (/\bassert(?:\.[A-Za-z][A-Za-z0-9_]*)?$/u.test(callee)) {
        assertions += 1;
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(file);
  return { testCount: tests.length, assertionCount: assertions, testNames: tests };
}
