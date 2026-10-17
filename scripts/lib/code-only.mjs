// SPDX-License-Identifier: Apache-2.0

import ts from "typescript";

// The three source rules below judge code, so they are applied to code. Scanning the
// whole file made a comment that used an English word indistinguishable from a type
// annotation, and the observable effect was not stricter typing -- it was authors
// routing around the words "any" and "eval" in prose. Comments, string/regexp literals
// and template text are blanked (length-preserving, so reported offsets still line
// up), but template interpolation expressions remain code.
//
// This does not weaken LINT_EXPLICIT_ANY. Implicit any is already refused by the
// compiler under strict; the rule's whole remaining job is explicit annotations, and
// those only ever appear in code.
export function codeOnly(content) {
  const source = ts.createSourceFile("source.ts", content, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  // Split UTF-16 code units, not code points: even an astral character must occupy
  // its original two offsets after blanking. Keep every JavaScript line terminator.
  const out = content.split("");
  const blank = (start, end) => {
    for (let index = start; index < end; index += 1) {
      if (!/[\r\n\u2028\u2029]/u.test(out[index])) out[index] = " ";
    }
  };
  const visit = (node) => {
    if (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node) || ts.isRegularExpressionLiteral(node)) {
      blank(node.getStart(source), node.end);
    } else {
      ts.forEachChild(node, visit);
    }
  };
  // Let the parser distinguish regexps from division and nested template text from
  // interpolation code. A plain scanner cannot determine those boundaries alone.
  visit(source);
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, out.join(""));
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (token === ts.SyntaxKind.SingleLineCommentTrivia || token === ts.SyntaxKind.MultiLineCommentTrivia) {
      blank(scanner.getTokenPos(), scanner.getTextPos());
    }
  }
  return out.join("");
}

// The one source rule that must NOT go through codeOnly(). A raw control byte is
// invisible in review: `file` classifies the source as binary data and BSD grep then
// reports ZERO matches for the whole file, so every grep-based scan over it silently
// sees nothing. INC-018 was one raw NUL that blinded two independent reviewers while git
// (which sniffs only the first 8000 bytes) and the JS gates (which readFile) stayed
// green. Both instances sat INSIDE string literals, which the blanker above erases, so
// this reads bytes and blanks nothing. TAB and LF are the only control bytes a text
// source may carry; a NUL that a digest genuinely wants is spelled with an escape, which
// is what the rest of the offending file already did at every other separator.
export function controlByteOffset(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("CONTROL_BYTE_SCAN_BYTES_REQUIRED");
  return bytes.findIndex((byte) => byte !== 0x09 && byte !== 0x0a && (byte < 0x20 || byte === 0x7f));
}
