// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
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
export function artifactPinOnly(before, after) {
  if (typeof before !== "string" || typeof after !== "string" || before === after) return false;
  const mask = (text) => text.replace(/^(\s*uses: actions\/(?:upload|download)-artifact@)[a-f0-9]{40}(?:[ \t]+#[ \t]*v[0-9]+(?:\.[0-9]+)*(?:[ \t]*))?$/gmu, "$1<PIN>");
  return mask(before) === mask(after);
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
  const portalSelected = coverage === "full" || categories.includes("portal") || (categories.includes("docs") && rules.documentAudit?.portalTests?.length > 0);
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
export function documentReaderClosure(texts, documents = []) {
  const readers = new Set([...texts].filter(([, text]) => (/README|docs\/wiki|wiki\//u.test(text) || documents.some((document) => text.includes(document) || text.includes(document.split("/").at(-1))))).map(([path]) => path));
  let changed = true;
  while (changed) {
    changed = false;
    for (const [path, text] of texts) {
      if (!readers.has(path) && [...readers].some((reader) => text.includes(reader) || text.includes(reader.split("/").at(-1)))) { readers.add(path); changed = true; }
    }
  }
  return sorted(readers);
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
  const files = git(root, ...(ref ? ["ls-tree", "-r", "--name-only", "-z", ref] : ["ls-files", "-z"])).toString().split("\0").filter(Boolean);
  const unresolved = [];
  const read = (path) => {
    try { return ref ? git(root, "show", `${ref}:${path}`).toString() : readFileSync(resolve(root, path), "utf8"); }
    catch { unresolved.push(path); return ""; }
  };
  const texts = new Map(files.filter((path) => /\.(?:mjs|js|ts|json|yml)$/u.test(path) && !path.startsWith("scripts/ci/") && !path.startsWith("tests/ci-") && !path.startsWith("tests/fixtures/ci-impact/")).map((path) => [path, read(path)]));
  const unknown = [...unresolved];
  for (const [path, text] of texts) {
    for (const [category, needle] of [["privacy", "privacy.mjs"], ["portal", "portal/"]]) {
      if (text.includes(needle) && !rules.consumers[category].includes(path)) unknown.push(path);
    }
  }
  const { texts: docsTexts, unresolved: documentUnresolved } = documentReaderSources(root, ref);
  const audit = rules.documentConsumers;
  const readers = documentReaderClosure(docsTexts, Object.keys(rules.docs));
  for (const document of Object.keys(rules.docs)) {
    const declaration = audit?.[document] === document ? rules.documentAudit : null;
    if (!declaration || !Array.isArray(declaration.readers) || !Array.isArray(declaration.tests)) { unknown.push(document); continue; }
    // README and wiki directory tokens cover direct paths, joins and directory
    // walkers; dependency edges below cover readers imported by other readers.
    for (const reader of readers) if (!declaration.readers.includes(reader)) unknown.push(reader);
    for (const reader of declaration.readers) if (!docsTexts.has(reader)) unknown.push(reader);
    for (const reader of readers) if (reader.startsWith("portal/tests/") && reader.endsWith(".test.mjs") && !declaration.portalTests?.includes(reader)) unknown.push(reader);
    for (const reader of readers) if (reader.startsWith("tests/") && reader.endsWith(".test.mjs") && (!declaration.tests.includes(reader) || !rules.docs[document].includes(reader))) unknown.push(reader);
  }
  return sorted([...unknown, ...unresolved, ...documentUnresolved]);
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
