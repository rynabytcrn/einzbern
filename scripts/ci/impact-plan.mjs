// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { P1_TASKS } from "../p1-sequence.mjs";
import { verifyBaseline, collectBaseline } from "./baseline-evidence.mjs";
export const canonical = (value) => JSON.stringify(value, function (key, item) {
  return item && !Array.isArray(item) && typeof item === "object" ? Object.fromEntries(Object.keys(item).sort().map((name) => [name, item[name]])) : item;
});
export const digest = (value) => createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : canonical(value)).digest("hex");
const sha = /^[a-f0-9]{40}$/u;
const safePath = (path) => typeof path === "string" && path.length > 0 && !path.startsWith("/") && !path.split("/").some((part) => ["..", ".", ""].includes(part)) && !/[\0\r\n\\]/u.test(path);
export function parseNameStatus(bytes) {
  const fields = bytes.toString("utf8").split("\0");
  if (fields.pop() !== "") throw new Error("Incomplete NUL diff");
  const records = [];
  while (fields.length) {
    const status = fields.shift();
    if (!/^(?:[AMD]|[RC][0-9]{1,3})$/u.test(status)) throw new Error("Unknown diff status");
    const paths = fields.splice(0, /^[RC]/u.test(status) ? 2 : 1);
    if (paths.length !== (/^[RC]/u.test(status) ? 2 : 1) || !paths.every(safePath)) throw new Error("Invalid diff path");
    records.push({ status, paths });
  }
  return records;
}
const maskArtifactPins = (text) => text.replace(/^(\s*uses: actions\/(?:upload|download)-artifact@)[a-f0-9]{40}(?:[ \t]+#[ \t]*v[0-9]+(?:\.[0-9]+)*(?:[ \t]*))?$/gmu, "$1<PIN>");
export const sourceAuditDigest = (path, text) => digest(path === ".github/workflows/ci.yml" ? maskArtifactPins(text) : text);
export function artifactPinOnly(before, after) {
  if (typeof before !== "string" || typeof after !== "string" || before === after) return false;
  return maskArtifactPins(before) === maskArtifactPins(after);
}
const sorted = (items) => [...new Set(items)].sort();
export function createPlan(input, rules, rulesHash) {
  const reasons = [];
  const baseline = verifyBaseline(input.baseline, { base: input.comparison?.base, repository: input.repository });
  if (!baseline.eligible) reasons.push(`baseline:${baseline.reason}`);
  if (!input.complete || !sha.test(input.head ?? "") || !sha.test(input.tree ?? "") || !sha.test(input.comparison?.base ?? "")) reasons.push("incomplete-comparison");
  if (!["pull_request", "push"].includes(input.event)) reasons.push("manual-or-release");
  if (!input.records?.length) reasons.push("empty-or-unavailable-diff");
  if (input.unaccountedConsumers?.length) reasons.push("unaccounted-consumers");
  const categories = [];
  const selected = [...rules.ciTests];
  for (const record of input.records ?? []) {
    if (record.status !== "M") { reasons.push(`structural-change:${record.status}`); continue; }
    for (const path of record.paths) {
      if (path === ".github/workflows/ci.yml" && artifactPinOnly(input.workflowBefore, input.workflowAfter)) categories.push("artifact-pin-only");
      else if (Object.hasOwn(rules.docs, path)) { categories.push("docs"); selected.push(...rules.docs[path]); }
      else if (rules.privacyPaths.includes(path)) { categories.push("privacy"); selected.push(...rules.privacyTests); }
      else if (rules.portalPaths.includes(path)) { categories.push("portal"); selected.push(...rules.portalTests); }
      else reasons.push(`full-path:${path}`);
    }
  }
  const fullCore = input.sourceCoreTests;
  const fullPortal = input.sourcePortalTests;
  if (!Array.isArray(fullCore) || !fullCore.length || !Array.isArray(fullPortal) || !fullPortal.length || selected.some((path) => !fullCore.includes(path))) reasons.push("incomplete-test-map");
  const coverage = reasons.length ? "full" : "selective";
  const coreTests = coverage === "full" ? fullCore : sorted(selected);
  const changedDocuments = (input.records ?? []).flatMap((record) => record.paths).filter((path) => Object.hasOwn(rules.docs, path));
  const portalConsumer = categories.some((category) => rules.consumers?.[category]?.some((path) => path.startsWith("portal/tests/") && path.endsWith(".test.mjs")));
  const portalSelected = coverage === "full" || categories.includes("portal") || portalConsumer || changedDocuments.some((path) => rules.documentAudit?.[path]?.portalTests?.length > 0);
  const shards = {
    checks: P1_TASKS.filter((task) => !["test", "portal"].includes(task)),
    core: ["test"],
    ...(portalSelected ? { portal: ["portal"] } : {}),
  };
  const plan = {
    schemaVersion: "einzbern.ci-impact-plan.v1", repository: input.repository,
    event: input.event, comparison: input.comparison, head: input.head, tree: input.tree,
    complete: input.complete, records: input.records ?? [], rulesVersion: rules.version, rulesHash,
    baseline: input.baseline ?? null, baselineEligibility: baseline, runId: input.runId, attempt: input.attempt,
    coverage, reasons: sorted(reasons), categories: sorted(categories), shards,
    prerequisites: Object.fromEntries(Object.keys(shards).map((key) => [key, key === "portal" ? ["build"] : []])),
    tasks: P1_TASKS.filter((task) => Object.values(shards).flat().includes(task)),
    sourceCoreTests: fullCore, sourcePortalTests: fullPortal, coreTests,
    portalTests: portalSelected ? fullPortal : [],
    notApplicable: coverage === "full" ? [] : [
      ...fullCore.filter((path) => !coreTests.includes(path)).map((path) => ({ path, rule: "audited-category-union", affectedPaths: (input.records ?? []).flatMap((r) => r.paths) })),
      ...(!portalSelected ? [{ task: "portal", rule: "no-portal-impact", affectedPaths: (input.records ?? []).flatMap((r) => r.paths) }] : []),
    ],
  };
  return { ...plan, planDigest: digest(plan) };
}
function git(root, ...args) { return execFileSync("git", ["-C", root, ...args], { maxBuffer: 32 * 1024 * 1024 }); }
export function sourceInput(root, env = process.env, eventOverride, ref = "HEAD") {
  const event = eventOverride ?? JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
  const kind = env.GITHUB_EVENT_NAME;
  const head = git(root, "rev-parse", ref).toString().trim();
  const tree = git(root, "rev-parse", `${ref}^{tree}`).toString().trim();
  const paths = git(root, "ls-tree", "-r", "--name-only", "-z", ref).toString().split("\0").filter(Boolean).sort();
  const result = { repository: env.GITHUB_REPOSITORY, event: kind, head, tree, runId: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT, complete: false, comparison: { base: null }, records: [], sourceCoreTests: paths.filter((p) => p.startsWith("tests/") && p.endsWith(".test.mjs")), sourcePortalTests: paths.filter((p) => p.startsWith("portal/tests/") && p.endsWith(".test.mjs")) };
  try {
    if (git(root, "rev-parse", "--is-shallow-repository").toString().trim() !== "false") throw new Error("Shallow history");
    const before = kind === "pull_request" ? event.pull_request.base.sha : event.before;
    const expectedHead = kind === "pull_request" ? event.pull_request.head.sha : event.after;
    if (!sha.test(before ?? "") || /^0+$/u.test(before) || head !== expectedHead) throw new Error("Invalid endpoints");
    const base = kind === "pull_request" ? git(root, "merge-base", before, head).toString().trim() : before;
    result.comparison = { base, before, head, method: kind === "pull_request" ? "merge-base" : "before" };
    result.records = parseNameStatus(git(root, "diff", "--name-status", "-z", "--find-renames", "--find-copies", base, head, "--"));
    result.complete = true;
    if (result.records.some((r) => r.paths.includes(".github/workflows/ci.yml"))) {
      result.workflowBefore = git(root, "show", `${base}:.github/workflows/ci.yml`).toString();
      result.workflowAfter = git(root, "show", `${ref}:.github/workflows/ci.yml`).toString();
    }
  } catch { result.complete = false; }
  return result;
}
export function loadRules(root) {
  const bytes = readFileSync(resolve(root, "scripts/ci/impact-rules.json"));
  return { rules: JSON.parse(bytes), rulesHash: digest(bytes) };
}
// Finite source audit, deliberately independent of the frozen declarations.
// Comments, regexes and string contents (including embedded fixture programs)
// are not executable path references. Templates retain their argument identity
// for executable tags; only real interpolations enter grouped code regions.
function sourceTokens(text, python = false, javascript = false) {
  let offset = 0, unresolved = false;
  const escaped = () => {
    const next = text[++offset]; offset++;
    return ({ n: "\n", r: "\r", t: "\t" })[next] ?? next ?? "";
  };
  const scan = (interpolation = false, depth = 0) => {
    const tokens = [], delimiters = [];
    if (depth > 100) { unresolved = true; offset = text.length; return tokens; }
    while (offset < text.length) {
      const rest = text.slice(offset);
      const skip = rest.match(python ? /^(?:\s+|#[^\n]*)/u : /^(?:\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/)/u);
      if (skip) { offset += skip[0].length; continue; }
      const quote = rest[0];
      if (interpolation && quote === "}" && !delimiters.length) { offset++; return tokens; }
      if (javascript && quote === "`") {
        offset++;
        const literals = [""], rawLiterals = [""], expressions = [];
        let uncertainEscape = false;
        while (offset < text.length && text[offset] !== "`") {
          if (text[offset] === "\\") {
            const start = offset;
            if (!/[nrt\\`$]/u.test(text[offset + 1] ?? "")) uncertainEscape = true;
            literals[literals.length - 1] += escaped(); rawLiterals[rawLiterals.length - 1] += text.slice(start, offset);
          }
          else if (text.startsWith("${", offset)) {
            offset += 2; expressions.push(scan(true, depth + 1)); literals.push(""); rawLiterals.push("");
          } else { rawLiterals[rawLiterals.length - 1] += text[offset]; literals[literals.length - 1] += text[offset++]; }
        }
        if (offset >= text.length) unresolved = true;
        else offset++;
        tokens.push({ kind: "template", value: literals.join("${}"), literals, rawLiterals, expressions: expressions.length, uncertainEscape });
        for (const expression of expressions) tokens.push({ kind: "punctuation", value: "{" }, ...expression, { kind: "punctuation", value: "}" });
        continue;
      }
      if (["\"", "'", "`"].includes(quote)) {
        const delimiter = python && rest.startsWith(quote.repeat(3)) ? quote.repeat(3) : quote;
        offset += delimiter.length;
        let value = "";
        while (offset < text.length && !text.startsWith(delimiter, offset)) value += text[offset] === "\\" ? escaped() : text[offset++];
        if (interpolation && offset >= text.length) unresolved = true;
        offset = Math.min(text.length, offset + delimiter.length);
        tokens.push({ kind: "string", value });
        continue;
      }
      // A slash at an expression boundary is a regexp, not a path or a comment.
      // Logical boundaries must match the multi-character tokens emitted below.
      if (!python && quote === "/" && (!tokens.length || /^(?:[=(\[,:!&|?;{]|&&|\|\||\?\?|return|throw|case|=>)$/u.test(tokens.at(-1).value))) {
        let end = 1, bracket = false;
        while (end < rest.length) {
          if (rest[end] === "\\") { end += 2; continue; }
          if (rest[end] === "[") bracket = true;
          if (rest[end] === "]") bracket = false;
          if (rest[end++] === "/" && !bracket) break;
        }
        while (/[a-z]/iu.test(rest[end] ?? "")) end++;
        tokens.push({ kind: "regexp", value: rest.slice(0, end) }); offset += end; continue;
      }
      const word = rest.match(/^[A-Za-z_$][\w$]*/u)?.[0];
      const value = word ?? rest.match(/^(?:=>|\.\.\.|\?\.|\?\?|===|!==|&&|\|\|)/u)?.[0] ?? quote;
      if (interpolation && !word) {
        if (["(", "[", "{"].includes(value)) delimiters.push(value);
        else if ([")", "]", "}"].includes(value) && delimiters.pop() !== ({ ")": "(", "]": "[", "}": "{" })[value]) unresolved = true;
      }
      tokens.push({ kind: word ? "identifier" : "punctuation", value }); offset += value.length;
    }
    if (interpolation) unresolved = true;
    return tokens;
  };
  return { tokens: scan(), unresolved };
}
const outputCalls = /^(?:writeFile(?:Sync|Atomic)?|appendFile(?:Sync)?|write_text|write_bytes|mkdir(?:Sync)?|mkdtemp(?:Sync)?|rm(?:Sync)?|unlink(?:Sync)?|stage|put|writeFixtureFile)$/u;
const inputCalls = /(?:read|open|access|stat|copyFile|^cp$|exec|spawn|run|import|require|load|inspect|verify|scan)/iu;
const pureCalls = /^(?:has|includes|startsWith|endsWith|startswith|endswith|test|match|matchAll|replace|replaceAll|split|slice|substring|indexOf|lastIndexOf|set|push|add|delete|sort|filter|map|flatMap|every|some|find|findIndex|isArray|keys|values|entries|fromEntries|stringify|parse|normalize|rooted|safePath|rootValue|digest|canonical)$/u;
const rooted = (path) => `repo:${posix.normalize(path)}`;
const rootValue = (value, source, relative = false) => {
  const repositoryPath = value.startsWith("repo:");
  if (repositoryPath) value = value.slice(5);
  if (value.startsWith("fixture:") || /[\n\r\0]|\$\{|^\w+:\/\//u.test(value)) return null;
  const path = posix.normalize(!repositoryPath && relative ? posix.join(posix.dirname(source), value) : value);
  return path === ".." || path.startsWith("../") || path.startsWith("/") ? null : path.replace(/^\.\//u, "");
};
// Literal imports/calls, constant aliases/arrays and static join/resolve/URL
// expressions are supported. A nonliteral prefix is never discarded to turn a
// fixture path into a repository path. Unknown languages/configuration retain
// exact input tokens conservatively; they cannot declare their own exemption.
// Optional inputAudit is preseeded with the source paths to fingerprint.
export function sourceDependencyGraph(texts, inputAudit) {
  const graph = new Map();
  graph.unresolved = [];
  const known = new Set(texts.keys());
  const addKnown = (set, value, source, relative = false, directory = false) => {
    const path = rootValue(value, source, relative);
    if (path === null) return;
    const built = (path.startsWith("dist/build/") ? path.slice(11) : path).replace(/^(packages\/.*)\.js$/u, "$1.ts");
    for (const candidate of known) if (candidate === path || candidate === built || (directory && path && candidate.startsWith(path.replace(/\/$/u, "") + "/"))) set.add(candidate);
    // Documents are intentionally absent from reader sources, but are graph
    // inputs. Do not reduce them to basenames or share all documents' readers.
    if (/\.(?:md)$/iu.test(path) || path === "docs/wiki" || path === "docs/wiki/") set.add(path.replace(/\/$/u, ""));
  };
  for (const [source, text] of texts) {
    const dependencies = new Set(); graph.set(source, dependencies);
    const auditInput = inputAudit?.has(source);
    const inputForms = [];
    if (auditInput) inputAudit.set(source, digest(inputForms));
    if (source === "scripts/ci/impact-rules.json") continue; // classification schema, audited separately below
    const javascript = /\.(?:[cm]?js|[cm]?ts|jsx|tsx)$/iu.test(source), python = /\.py$/iu.test(source);
    const { tokens, unresolved } = sourceTokens(text, python, javascript), values = tokens.map((token) => token.value);
    if (unresolved) { graph.unresolved.push(source); if (auditInput) inputForms.push(digest({ unresolved: true })); }
    const pairs = new Map(), openings = new Map(), stack = [];
    for (let index = 0; index < tokens.length; index++) {
      if (tokens[index].kind !== "punctuation") continue;
      if (["(", "[", "{"].includes(values[index])) stack.push(index);
      else if ([")", "]", "}"].includes(values[index])) { const start = stack.pop(); if (start !== undefined) { pairs.set(start, index); openings.set(index, start); } }
    }
    const templates = new Map(), templateEnds = new Map();
    for (let index = 0; index < tokens.length; index++) if (tokens[index].kind === "template") {
      const args = []; let end = index + 1;
      for (let expression = 0; expression < tokens[index].expressions; expression++) {
        if (!pairs.has(end)) break; // an incomplete interpolation is already unresolved
        args.push([end + 1, pairs.get(end)]); end = pairs.get(end) + 1;
      }
      templates.set(index, { args, end }); templateEnds.set(end, index);
    }
    const parts = (start, end) => {
      const result = []; let first = start;
      for (let index = start; index < end; index++) {
        if (pairs.has(index)) index = pairs.get(index);
        else if (values[index] === ",") { result.push([first, index]); first = index + 1; }
      }
      result.push([first, end]); return result;
    };
    const bindings = new Map(), bindingForms = new Map(), tagDefinitions = new Map(), tagAliases = new Map(), tagFunctions = new Set();
    const templateValues = (index, depth = 0) => {
      const token = tokens[index], template = templates.get(index);
      if (depth > 20 || token.uncertainEscape || template.args.length !== token.expressions) return [];
      let result = [token.literals[0]];
      for (const [part, [start, end]] of template.args.entries()) {
        const arguments_ = evaluate(start, end, depth + 1);
        if (!arguments_.length) return [];
        result = result.flatMap((prefix) => arguments_.map((value) => prefix + value + token.literals[part + 1]));
      }
      return result;
    };
    const evaluate = (start, end, depth = 0) => {
      if (depth > 20 || start >= end) return [];
      while (["await", "...", "new"].includes(values[start])) start++;
      if (values[start] === "(" && pairs.get(start) === end - 1) return evaluate(start + 1, end - 1, depth + 1);
      if (tokens[start]?.kind === "template") return templates.get(start).end === end ? templateValues(start, depth + 1) : [];
      if (start + 1 === end) return tokens[start].kind === "string" ? [values[start]] : bindings.get(values[start]) ?? [];
      const expression = values.slice(start, end).join("");
      if (expression === "import.meta.dirname") return [rooted(posix.dirname(source))];
      if (expression === "import.meta.url") return [rooted(source)];
      if (expression === "process.cwd()") return ["repo:."];
      if (values[start] === "[" && pairs.get(start) === end - 1) return parts(start + 1, end - 1).flatMap(([a, b]) => evaluate(a, b, depth + 1));
      let opening = start;
      while (opening < end && values[opening] !== "(") opening++;
      if (opening === end || !pairs.has(opening)) return [];
      const closing = pairs.get(opening), name = values[opening - 1];
      const args = parts(opening + 1, closing).map(([a, b]) => evaluate(a, b, depth + 1));
      if (["fileURLToPath", "Path", "freeze"].includes(name)) return args[0] ?? [];
      if (name === "dirname") return (args[0] ?? []).map((path) => path.startsWith("repo:") ? rooted(posix.dirname(path.slice(5))) : path.startsWith("fixture:") ? path : posix.dirname(path));
      if (["mkdtemp", "mkdtempSync", "tmpdir"].includes(name)) return ["fixture:temporary"];
      if (name === "URL") {
        return (args[0] ?? []).flatMap((path) => (args[1] ?? []).filter((base) => base.startsWith("repo:")).map((base) => rooted(posix.join(posix.dirname(base.slice(5)), path))));
      }
      if (!["join", "resolve"].includes(name) || args.some((arg) => !arg.length)) return [];
      let joined = args[0];
      for (const arg of args.slice(1)) joined = joined.flatMap((base) => arg.map((part) => base.startsWith("fixture:") ? base : base.startsWith("repo:") ? rooted(posix.join(base.slice(5), part)) : posix.join(base, part)));
      return joined;
    };
    const rememberBinding = (name, start, end, definitions = bindingForms) => {
      if (!auditInput) return;
      const form = tokens.slice(start, end), forms = definitions.get(name) ?? new Map();
      forms.set(digest(form), sorted(form.filter((token) => token.kind === "identifier").map((token) => token.value)));
      definitions.set(name, forms);
    };
    // Tag callees also depend on their local function/class definitions. Keep
    // these only for tag fingerprints, without widening ordinary value edits.
    for (let index = 0; index < tokens.length; index++) {
      if (!["function", "class"].includes(values[index])) continue;
      const name = index + (values[index + 1] === "*" ? 2 : 1);
      if (tokens[name]?.kind !== "identifier") continue;
      let body = name + 1;
      while (body < tokens.length && values[body] !== "{" && values[body] !== ";") { if (pairs.has(body)) body = pairs.get(body); body++; }
      if (pairs.has(body)) {
        rememberBinding(values[name], index, pairs.get(body) + 1, tagDefinitions);
        if (values[index] === "function") tagFunctions.add(values[name]);
      }
    }
    // File-local aliases and finite loop sets reach a fixed point. Names in
    // separate scopes are unioned, conservatively retaining possible inputs.
    for (let pass = 0; pass < 8; pass++) {
      let changed = false;
      for (let index = 0; index < tokens.length - 2; index++) {
        if (tokens[index].kind !== "identifier" || !["=", "of"].includes(values[index + 1])) continue;
        let end = index + 2;
        while (end < tokens.length && ![";", ",", ")", "}"].includes(values[end])) { if (pairs.has(end)) end = pairs.get(end); end++; }
        if (pass === 0) {
          rememberBinding(values[index], index + 2, end);
          const aliases = tagAliases.get(values[index]) ?? new Set();
          let start = index + 2, closing = end;
          while (values[start] === "(" && pairs.get(start) === closing - 1) { start++; closing--; }
          aliases.add(closing === start + 1 && tokens[start]?.kind === "identifier" ? values[start] : null); tagAliases.set(values[index], aliases);
        }
        const next = sorted([...(bindings.get(values[index]) ?? []), ...evaluate(index + 2, end)]);
        if (canonical(next) !== canonical(bindings.get(values[index]) ?? [])) { bindings.set(values[index], next); changed = true; }
      }
      for (const [opening, closing] of pairs) if (values[opening] === "[" && values[closing + 1] === "of") {
        let end = closing + 2;
        while (end < tokens.length && values[end] !== ")") { if (pairs.has(end)) end = pairs.get(end); end++; }
        const items = evaluate(closing + 2, end);
        for (let index = opening + 1; index < closing; index++) if (tokens[index].kind === "identifier") {
          if (pass === 0) rememberBinding(values[index], closing + 2, end);
          const next = sorted([...(bindings.get(values[index]) ?? []), ...items]);
          if (canonical(next) !== canonical(bindings.get(values[index]) ?? [])) { bindings.set(values[index], next); changed = true; }
        }
      }
      if (!changed) break;
    }
    // Keep the finite input surface even when its actual path is unresolved.
    // Referenced aliases retain their defining tokens; changing a dynamic
    // binding must not inherit the old audit merely because it still evaluates
    // to no known path. Other value-only edits and comments are not input forms.
    const inputForm = (start, end, tagged = false) => {
      const expression = tokens.slice(start, end), aliases = new Map();
      const pending = new Set(expression.filter((token) => token.kind === "identifier").map((token) => token.value));
      for (const name of pending) {
        const definitions = [bindingForms.get(name), ...(tagged ? [tagDefinitions.get(name)] : [])].filter(Boolean);
        if (aliases.has(name) || !definitions.length) continue;
        const forms = definitions.flatMap((definition) => [...definition.values()]); aliases.set(name, definitions.flatMap((definition) => [...definition.keys()]));
        for (const identifier of forms.flat()) pending.add(identifier);
      }
      return digest({ expression: digest(expression), aliases: Object.fromEntries(sorted(aliases.keys()).map((name) => [name, sorted(aliases.get(name))])) });
    };
    const nonCallees = /^(?:return|throw|case|yield|await|new|typeof|void|delete|in|of|instanceof|else|do|if|for|while|switch|catch|with|function|class|const|let|var|export|default)$/u;
    const calleeStart = (end, depth = 0) => {
      if (depth > 20 || end <= 0) return null;
      const last = end - 1; let start;
      if (tokens[last].kind === "identifier" && (!nonCallees.test(values[last]) || [".", "?."].includes(values[last - 1]))) start = last;
      else if ([")", "]"].includes(values[last]) && openings.has(last)) {
        start = openings.get(last);
        if (/^(?:if|for|while|switch|catch|with)$/u.test(values[start - 1] ?? "") && ![".", "?."].includes(values[start - 2])) return null;
        const receiver = calleeStart(start, depth + 1);
        if (receiver !== null) start = receiver;
      } else if (templateEnds.has(end)) {
        start = templateEnds.get(end);
        start = calleeStart(start, depth + 1) ?? start;
      } else if (values[last] === "}" && openings.has(last)) {
        const parameters = openings.get(openings.get(last) - 1);
        if (parameters === undefined) return null;
        let declaration = parameters - 1;
        if (tokens[declaration]?.kind === "identifier" && values[declaration] !== "function") declaration--;
        if (values[declaration] === "*") declaration--;
        if (values[declaration] !== "function") return null;
        start = values[declaration - 1] === "async" ? declaration - 1 : declaration;
        if (!["=", "(", "[", ",", ":", "return", "=>", "?", "||", "&&", "??"].includes(values[start - 1])) return null;
      } else return null;
      if ([".", "?."].includes(values[start - 1])) return calleeStart(start - 1, depth + 1);
      return start;
    };
    const templateCallee = (index) => {
      const start = calleeStart(index); let callee = start, end = index;
      while (callee !== null && values[callee] === "(" && pairs.get(callee) === end - 1) { callee++; end--; }
      return { start, callee, end };
    };
    // Track only finite references to the ambient object, its String
    // constructor and raw tag. An unknown property of either relevant receiver
    // cannot prove that a later String.raw invocation still uses the intrinsic.
    const intrinsicAliases = new Map();
    const intrinsicValue = (start, end, depth = 0) => {
      if (depth > 20 || start >= end) return null;
      let cursor = start, value;
      if (values[cursor] === "(" && pairs.has(cursor) && pairs.get(cursor) < end) {
        value = intrinsicValue(cursor + 1, pairs.get(cursor), depth + 1);
        cursor = pairs.get(cursor) + 1;
      } else if (tokens[cursor]?.kind === "identifier") {
        value = ["globalThis", "global"].includes(values[cursor]) ? "global" : values[cursor] === "String" ? "string" : intrinsicAliases.get(values[cursor]);
        cursor++;
      } else return null;
      if (!value) return null;
      while (cursor < end) {
        let key;
        if ([".", "?."].includes(values[cursor]) && tokens[cursor + 1]?.kind === "identifier") {
          key = values[cursor + 1]; cursor += 2;
        } else if (values[cursor] === "[" && pairs.has(cursor) && pairs.get(cursor) < end) {
          key = pairs.get(cursor) === cursor + 2 && tokens[cursor + 1]?.kind === "string" ? values[cursor + 1] : null;
          cursor = pairs.get(cursor) + 1;
        } else return null;
        if (value === "global") value = key === "String" ? "string" : ["globalThis", "global"].includes(key) ? "global" : key === null || key === "constructor" ? "uncertain" : "unrelated";
        else if (value === "string") value = key === "raw" ? "raw" : ["fromCharCode", "fromCodePoint"].includes(key) ? "static" : "uncertain";
        else if (value !== "unrelated") value = "uncertain";
      }
      return value;
    };
    const assignmentEnd = (start) => {
      let end = start;
      while (end < tokens.length && ![";", ",", ")", "}"].includes(values[end])) { if (pairs.has(end)) end = pairs.get(end); end++; }
      return end;
    };
    let uncertainDestructure = false;
    for (let pass = 0; pass < 8; pass++) {
      let changed = false;
      for (let index = 1; index < tokens.length - 2; index++) {
        if (tokens[index].kind === "identifier" && values[index + 1] === "=" && ["const", "let", "var"].includes(values[index - 1])) {
          const kind = intrinsicValue(index + 2, assignmentEnd(index + 2));
          if (["global", "string", "raw"].includes(kind) && intrinsicAliases.get(values[index]) !== kind) { intrinsicAliases.set(values[index], kind); changed = true; }
        }
        if (values[index] !== "{" || !pairs.has(index) || values[pairs.get(index) + 1] !== "=") continue;
        const closing = pairs.get(index), kind = intrinsicValue(closing + 2, assignmentEnd(closing + 2));
        if (!["global", "string"].includes(kind)) {
          if (parts(index + 1, closing).some(([first]) => ["String", "raw"].includes(values[first + (values[first] === "[" ? 1 : 0)]))) uncertainDestructure = true;
          continue;
        }
        for (const [first, last] of parts(index + 1, closing)) {
          if (first === last) continue;
          const key = values[first] === "[" && pairs.get(first) === first + 2 && tokens[first + 1]?.kind === "string" ? [values[first + 1]] : values[first] === "[" ? [] : [values[first]];
          const name = values[first + 1] === ":" ? first + 2 : first;
          if (key.length !== 1 || tokens[name]?.kind !== "identifier" || name >= last) { uncertainDestructure = true; continue; }
          const next = kind === "global" && key[0] === "String" ? "string" : kind === "global" && ["globalThis", "global"].includes(key[0]) ? "global" : kind === "string" && key[0] === "raw" ? "raw" : null;
          if (next && intrinsicAliases.get(values[name]) !== next) { intrinsicAliases.set(values[name], next); changed = true; }
        }
      }
      if (!changed) break;
    }
    const readonlyGlobalStrings = new Set();
    const reference = (index) => {
      let start = index, end = index + 1;
      while (end < tokens.length) {
        if (values[end] === ")" && openings.get(end) === start - 1) { start--; end++; continue; }
        if ([".", "?."].includes(values[end]) && tokens[end + 1]?.kind === "identifier") { end += 2; continue; }
        if (values[end] === "[" && pairs.has(end)) { end = pairs.get(end) + 1; continue; }
        break;
      }
      return { start, end, kind: intrinsicValue(start, end) };
    };
    let ambientUnsafe = uncertainDestructure || [...intrinsicAliases.values()].includes("raw");
    for (let index = 0; index < tokens.length; index++) {
      // A computed String key on an unknown receiver could be the same
      // constructor. Literal arrays have no member receiver and are ignored.
      const computedString = values[index] === "[" && pairs.get(index) === index + 2 && values[index + 1] === "String" &&
        ([")", "]"].includes(values[index - 1]) || tokens[index - 1]?.kind === "identifier");
      if (computedString) {
        const receiver = calleeStart(index);
        if (receiver === null || intrinsicValue(receiver, index) === null) ambientUnsafe = true;
      }
      const name = values[index];
      if (tokens[index].kind !== "identifier" || !(["globalThis", "global"].includes(name) || intrinsicAliases.has(name)) || [".", "?."].includes(values[index - 1])) continue;
      // A binding name is not a read of its ambient value.
      if (["const", "let", "var"].includes(values[index - 1]) && values[index + 1] === "=") continue;
      const { start, end, kind } = reference(index), next = values[end];
      if (!kind || kind === "unrelated") continue;
      const readonlyCall = ["string", "static", "raw"].includes(kind) && next === "(" && pairs.has(end) && values[pairs.get(end) + 1] !== "{";
      const rawTag = kind === "raw" && tokens[end]?.kind === "template";
      const aliasName = values[start - 2], aliasKind = intrinsicAliases.get(aliasName);
      const localAlias = values[start - 1] === "=" && tokens[start - 2]?.kind === "identifier" && aliasKind === kind;
      const destructuredAlias = values[start - 1] === "=" && values[start - 2] === "}" && openings.has(start - 2);
      const bareMention = kind === "global" && next === ";" && (start === 0 || [";", "{", "}"].includes(values[start - 1]));
      const safe = readonlyCall || rawTag || localAlias && kind !== "raw" || destructuredAlias && kind !== "raw" || bareMention;
      if (!safe) ambientUnsafe = true;
      if (safe && ["string", "static", "raw"].includes(kind)) for (let member = start + 1; member < end; member++) if (values[member] === "String" && [".", "?."].includes(values[member - 1])) readonlyGlobalStrings.add(member);
    }
    // String conversions and the intrinsic's finite static calls do not mutate
    // its raw tag. Every other reference still needs proof: declarations,
    // parameters, assignments, computed members and escaping aliases are unsafe.
    const rawTags = new Set([...templates.keys()].flatMap((index) => {
      const { callee, end } = templateCallee(index);
      return callee !== null && values.slice(callee, end).join("") === "String.raw" ? [callee] : [];
    }));
    const readonlyStringUse = (index) => {
      if (readonlyGlobalStrings.has(index)) return true;
      if (rawTags.has(index)) return true;
      if ([".", "?.", "function"].includes(values[index - 1]) || values[index - 1] === "*" && values[index - 2] === "function") return false;
      const opening = values[index + 1] === "(" ? index + 1 : values[index + 1] === "." &&
        ["fromCharCode", "fromCodePoint", "raw"].includes(values[index + 2]) && values[index + 3] === "(" ? index + 3 : null;
      // A named function/method's parameter list is not a conversion call.
      return opening !== null && pairs.has(opening) && values[pairs.get(opening) + 1] !== "{";
    };
    // String.raw is data only while it is the unbound intrinsic. A user tag,
    // including one named raw/normalize/writeFileSync, has executable inputs.
    const intrinsicRaw = !ambientUnsafe && !tokens.some((token, index) => token.kind === "identifier" && token.value === "String" && !readonlyStringUse(index));
    const knownTag = (name, seen = new Set()) => {
      if (name === null || seen.has(name) || seen.size > 20) return false;
      if (!tagAliases.has(name)) return tagFunctions.has(name);
      return [...tagAliases.get(name)].every((alias) => knownTag(alias, new Set([...seen, name])));
    };
    if (!javascript && !python) {
      // Configuration and unsupported text syntax are potential inputs, never
      // presumed non-executable based on their suffix. Exact unquoted path
      // tokens are also retained (e.g. YAML input: scripts/read-doc.py).
      for (let index = 0; index < tokens.length; index++) if (tokens[index].kind === "string" && values[index + 1] !== ":") addKnown(dependencies, values[index], source);
      const uncommented = text.replace(/^\s*#.*$/gmu, "");
      for (const match of uncommented.matchAll(/(?:^|[\s:"'=])([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.(?:md|mjs|js|ts|py|sh|yaml|json))(?=$|[\s,"'])/gmu)) addKnown(dependencies, match[1], source);
    }
    for (let index = 0; index < tokens.length; index++) {
      if (javascript && tokens[index].kind === "template") {
        const { start, callee, end } = templateCallee(index), template = templates.get(index);
        if (start !== null && !(intrinsicRaw && intrinsicValue(callee, end) === "raw")) {
          if (auditInput) inputForms.push(digest({ tag: inputForm(start, index, true), template: inputForm(index, template.end, true), args: template.args.map(([a, b]) => inputForm(a, b, true)) }));
          for (const value of [...tokens[index].literals, ...tokens[index].rawLiterals, ...templateValues(index)]) addKnown(dependencies, value, source);
          let reliable = !tokens[index].uncertainEscape && end === callee + 1 && knownTag(values[callee]);
          for (const [a, b] of template.args) {
            const arguments_ = evaluate(a, b);
            if (!arguments_.length) reliable = false;
            for (const value of arguments_) addKnown(dependencies, value, source);
          }
          // Member/factory/chained or dynamic aliases retain all their tokens
          // but an unproven callee requires full coverage, even with known args.
          if (!reliable && !graph.unresolved.includes(source)) graph.unresolved.push(source);
        }
      }
      if (tokens[index].kind === "string" && (values[index - 1] === "from" || values[index - 1] === "import")) {
        addKnown(dependencies, values[index], source, values[index].startsWith("."));
        if (auditInput) inputForms.push(digest({ import: values[index] }));
      }
      if (tokens[index].kind !== "punctuation" || values[index] !== "(" || !pairs.has(index)) continue;
      const name = values[index - 1];
      if (!name || outputCalls.test(name) || pureCalls.test(name) || ["join", "resolve", "dirname", "URL", "fileURLToPath", "test"].includes(name)) continue;
      if (python && name === "Path") continue; // construction alone neither reads nor calls the file
      if (values[index - 2] === "." && values[index - 3] === "assert") continue;
      const args = parts(index + 1, pairs.get(index));
      if (python && name === "open" && evaluate(...(args[1] ?? [index, index])).some((mode) => /^[wax]/u.test(mode))) continue;
      let form = null;
      if (auditInput) {
        let callee = index - 1;
        while ([".", "?."].includes(values[callee - 1])) {
          let start = callee - 2;
          if (values[start] === ")") for (const [opening, closing] of pairs) if (closing === start) { start = opening - 1; break; }
          if (start < 0 || start >= callee) break;
          callee = start;
        }
        form = { call: inputForm(callee, index), args: args.map(([start, end]) => inputForm(start, end)) };
      }
      if (python && /^(?:read_text|read_bytes|open)$/u.test(name) && values[index - 2] === ".") {
        let start = index - 3;
        if (values[start] === ")") for (const [opening, closing] of pairs) if (closing === start) { start = opening - 1; break; }
        if (form) form.receiver = inputForm(start, index - 2);
        for (const value of evaluate(start, index - 2)) addKnown(dependencies, value, source);
      }
      if (form) inputForms.push(digest(form));
      // Reads and execution can flow through wrappers. Exact path-valued args
      // to unknown calls are conservative edges too, rather than exemptions.
      const inputArgs = /^(?:cp|copyFile(?:Sync)?)$/u.test(name) ? args.slice(0, 1) : args;
      for (const [start, end] of inputArgs) {
        for (const value of evaluate(start, end)) addKnown(dependencies, value, source, ["import", "require"].includes(name) && value.startsWith("."), /(?:readdir|copy|^cp$|walk|treeFiles|filesOf|pagesOf|mirror)/iu.test(name));
      }
      if (inputCalls.test(name)) {
        // A dynamic expression with an exact input token remains conservative.
        // Embedded source payloads are single string tokens, never rescanned.
        for (let cursor = index + 1; cursor < pairs.get(index); cursor++) if (tokens[cursor].kind === "template") {
          for (const part of tokens[cursor].literals) if (part && !part.includes("\n")) addKnown(dependencies, part, source);
        }
      }
    }
    if (auditInput) inputAudit.set(source, digest(sorted(inputForms)));
  }
  return graph;
}
// Construction freezes this independently of sourceAudit and the root maps.
// It is a finite token audit, not a claim to resolve dynamic environment paths.
export function categoryInputAudit(texts, rules, inputs) {
  const paths = sorted([...rules.privacyPaths, ...rules.portalPaths]).filter((path) => texts.has(path));
  if (!inputs) { inputs = new Map(paths.map((path) => [path, null])); sourceDependencyGraph(texts, inputs); }
  return Object.fromEntries(paths.map((path) => [path, inputs.get(path)]));
}
function readerClosure(graph, seeds) {
  const readers = new Set(seeds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [path, dependencies] of graph) {
      if (!readers.has(path) && [...readers].some((reader) => dependencies.has(reader) || dependencies.has("docs/wiki") && reader.startsWith("docs/wiki/"))) { readers.add(path); changed = true; }
    }
  }
  return sorted(readers);
}
export function documentReaderClosure(texts, documents = [], graph = sourceDependencyGraph(texts)) {
  return readerClosure(graph, documents).filter((path) => texts.has(path));
}
export function categoryReaderAudit(texts, rules, graph = sourceDependencyGraph(texts)) {
  return Object.fromEntries(["privacy", "portal"].map((category) => {
    const paths = rules[`${category}Paths`] ?? [];
    const readers = readerClosure(graph, paths).filter((path) => texts.has(path));
    return [category, { readers, tests: readers.filter((path) => path.startsWith("tests/") && path.endsWith(".test.mjs")) }];
  }));
}
// Readers are not limited to JavaScript: a test may invoke Python, a shell
// script, or a configuration-driven tool. Inspect every tracked text input
// except documentation and known opaque image/font assets. Unknown binary or
// unreadable inputs remain unresolved, rather than becoming a source exemption.
export function documentReaderSources(root, ref) {
  const files = git(root, ...(ref ? ["ls-tree", "-r", "--name-only", "-z", ref] : ["ls-files", "-z"])).toString().split("\0").filter(Boolean);
  const texts = new Map(), unresolved = [];
  for (const path of files) {
    if (/\.(?:md|png|jpe?g|gif|webp|ico|woff2?|ttf|otf)$/iu.test(path)) continue;
    try {
      const bytes = ref ? git(root, "show", `${ref}:${path}`) : readFileSync(resolve(root, path));
      if (!isUtf8(bytes) || bytes.includes(0)) throw new Error("Unknown non-text source");
      texts.set(path, bytes.toString("utf8"));
    } catch { unresolved.push(path); }
  }
  return { texts, unresolved: sorted(unresolved) };
}
// Audit all tracked executable/configuration readers, including staged additions.
// The same scanner can read immutable Git bytes for an earlier baseline.
export function checkConsumers(root, rules, ref) {
  const { texts, unresolved } = documentReaderSources(root, ref);
  const unknown = [...unresolved];
  // A frozen source inventory binds the reviewed finite semantics to real bytes.
  // Changed category bytes may retain selection only with the same frozen input
  // surface. An added/unresolved read or call invalidates that stale audit even
  // when the finite graph cannot derive the actual document or affected root.
  // These signatures never supply missing edges or replace either root map.
  const categoryInputs = new Set([...rules.privacyPaths, ...rules.portalPaths]);
  const inputs = new Map([...categoryInputs].map((path) => [path, null])), graph = sourceDependencyGraph(texts, inputs);
  unknown.push(...graph.unresolved);
  for (const [path, text] of texts) if (path !== "scripts/ci/impact-rules.json" && (!rules.sourceAudit?.[path] || rules.sourceAudit[path] !== sourceAuditDigest(path, text) && (!categoryInputs.has(path) || rules.categoryInputAudit?.[path] !== inputs.get(path)))) unknown.push(path);
  for (const [category, actual] of Object.entries(categoryReaderAudit(texts, rules, graph))) {
    const declaration = rules.consumers?.[category];
    if (!Array.isArray(declaration)) { unknown.push(`${category}-consumer-declaration`); continue; }
    for (const reader of actual.readers) if (!declaration.includes(reader)) unknown.push(reader);
    for (const reader of declaration) if (!actual.readers.includes(reader)) unknown.push(reader);
    for (const test of actual.tests) if (!rules[`${category}Tests`]?.includes(test)) unknown.push(test);
  }
  const audit = rules.documentConsumers;
  for (const document of Object.keys(rules.docs)) {
    const readers = documentReaderClosure(texts, [document], graph);
    const declaration = audit?.[document] === document ? rules.documentAudit?.[document] : null;
    if (!declaration || !Array.isArray(declaration.readers) || !Array.isArray(declaration.tests)) { unknown.push(document); continue; }
    for (const reader of readers) if (!declaration.readers.includes(reader)) unknown.push(reader);
    for (const reader of declaration.readers) if (!readers.includes(reader)) unknown.push(reader);
    for (const reader of readers) if (reader.startsWith("portal/tests/") && reader.endsWith(".test.mjs") && !declaration.portalTests?.includes(reader)) unknown.push(reader);
    for (const reader of readers) if (reader.startsWith("tests/") && reader.endsWith(".test.mjs") && (!declaration.tests.includes(reader) || !rules.docs[document].includes(reader))) unknown.push(reader);
  }
  return sorted(unknown);
}
export function validatePlan(plan, root, env = process.env) {
  const input = sourceInput(root, env);
  const { rules, rulesHash } = loadRules(root);
  input.baseline = plan.baseline;
  input.unaccountedConsumers = checkConsumers(root, rules);
  const expected = createPlan(input, rules, rulesHash);
  if (canonical(expected) !== canonical(plan)) throw new Error("Impact plan does not match independently derived source/event/rules/rosters");
  return plan;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [mode, path] = process.argv.slice(2);
  const root = process.cwd();
  if (mode === "validate-baseline") {
    const plan = JSON.parse(readFileSync(path));
    const env = { GITHUB_EVENT_NAME: plan.event, GITHUB_REPOSITORY: plan.repository, GITHUB_RUN_ID: plan.runId, GITHUB_RUN_ATTEMPT: plan.attempt };
    const event = { before: plan.comparison.before, after: plan.head, pull_request: { base: { sha: plan.comparison.before }, head: { sha: plan.head } } };
    const input = sourceInput(root, env, event, plan.head);
    const bytes = git(root, "show", `${plan.head}:scripts/ci/impact-rules.json`);
    const rules = JSON.parse(bytes);
    input.baseline = plan.baseline;
    input.unaccountedConsumers = checkConsumers(root, rules, plan.head);
    // Eligibility alone cannot authenticate a previous run: collectBaseline
    // requires its actual GitHub successful verify plus rehashed artifacts.
    if (canonical(createPlan(input, rules, digest(bytes))) !== canonical(plan)) throw new Error("Baseline plan cannot be derived from Git");
  } else if (["validate", "validate-remote"].includes(mode)) {
    const plan = validatePlan(JSON.parse(readFileSync(path)), root);
    if (mode === "validate-remote" && plan.baselineEligibility.eligible) {
      const input = sourceInput(root);
      const actual = await collectBaseline(input, root, plan.baseline.runId);
      if (canonical(actual) !== canonical(plan.baseline)) throw new Error("Baseline remote provenance no longer validates");
    }
  }
  else if (mode === "create") {
    const input = sourceInput(root);
    input.baseline = await collectBaseline(input, root);
    const { rules, rulesHash } = loadRules(root);
    input.unaccountedConsumers = checkConsumers(root, rules);
    const plan = createPlan(input, rules, rulesHash);
    writeFileSync(path, JSON.stringify(plan, null, 2) + "\n", { flag: "wx" });
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${JSON.stringify(process.env.GITHUB_EVENT_NAME === "workflow_dispatch" && JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH)).inputs?.mode === "pf2-h1" ? ["pf2-h1"] : Object.keys(plan.shards).map((s) => `p1-${s}`))}\n`);
  } else throw new Error("Expected create or validate");
}
