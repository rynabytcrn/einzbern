// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createPlan, artifactPinOnly, parseNameStatus, digest } from "../scripts/ci/impact-plan.mjs";
const rules = JSON.parse(readFileSync(new URL("../scripts/ci/impact-rules.json", import.meta.url)));
const core = [...new Set([...rules.ciTests, ...rules.privacyTests, ...rules.portalTests, ...Object.values(rules.docs).flat()])].sort();
const base = "a".repeat(40);
const baseline = { state: "verified", repository: "example/project", sha: base, coverage: "full", verification: "CI_VERIFIED", conclusion: "success", runId: "1", attempt: "1", workflow: ".github/workflows/ci.yml", evidenceDigest: "1".repeat(64) };
function plan(patch = {}) {
  return createPlan({ repository: "example/project", event: "pull_request", complete: true, head: "b".repeat(40), tree: "c".repeat(40), comparison: { base }, baseline, runId: "2", attempt: "1", records: [{ status: "M", paths: ["README.md"] }], sourceCoreTests: core, sourcePortalTests: ["portal/tests/portal.test.mjs"], ...patch }, rules, digest(rules));
}
test("actual cumulative PR receipts classify #29/#31/#32/#33, with explicitly synthetic baseline eligibility", () => {
  for (const [number, category, count] of [[29, "full", 99], [31, "artifact-pin-only", 1], [32, "artifact-pin-only", 1], [33, "privacy", 2]]) {
    const fixture = JSON.parse(readFileSync(new URL(`./fixtures/ci-impact/pr-${number}.json`, import.meta.url)));
    assert.equal(fixture.records.length, count);
    if ([31, 32].includes(number)) {
      const refs = (text) => [...text.matchAll(/actions\/(?:upload|download)-artifact@[a-f0-9]{40}/gu)].map((match) => match[0]);
      const old = refs(fixture.workflowBefore), current = refs(fixture.workflowAfter);
      assert.equal(old.filter((value, index) => value !== current[index]).length, number === 31 ? 1 : 2);
    }
    const actual = plan({ ...fixture, comparison: { base: fixture.base }, baseline: { ...baseline, sha: fixture.base } });
    assert.equal(actual.coverage, number === 29 ? "full" : "selective");
    if (number !== 29) assert.ok(actual.categories.includes(category));
  }
});
test("known categories union; any cumulative core change wins even when last commit is docs", () => {
  const docsPrivacy = plan({ records: [{ status: "M", paths: ["README.md"] }, { status: "M", paths: ["scripts/lib/privacy.mjs"] }] });
  assert.equal(docsPrivacy.coverage, "selective");
  for (const file of rules.privacyTests) assert.ok(docsPrivacy.coreTests.includes(file));
  const portal = plan({ records: [{ status: "M", paths: ["README.md"] }, { status: "M", paths: [rules.portalPaths[0]] }] });
  assert.deepEqual(portal.portalTests, portal.sourcePortalTests);
  assert.equal(plan({ records: [{ status: "M", paths: ["packages/core/src/index.ts"] }, { status: "M", paths: ["README.md"] }] }).coverage, "full");
});
test("uncertain/new/renamed/copied/deleted paths, baseline and manual/release always choose full", () => {
  for (const records of [[{ status: "A", paths: ["README.md"] }], [{ status: "R100", paths: ["README.md", "docs/new.md"] }], [{ status: "C100", paths: ["README.md", "copy.md"] }], [{ status: "D", paths: ["README.md"] }], [{ status: "M", paths: ["Readme.md"] }], [{ status: "M", paths: ["specs/protocol.md"] }], [{ status: "M", paths: ["scripts/ci/impact-rules.json"] }]]) assert.equal(plan({ records }).coverage, "full");
  for (const patch of [{ baseline: null }, { baseline: { ...baseline, sha: "f".repeat(40) } }, { complete: false }, { records: [] }, { event: "workflow_dispatch" }, { event: "release" }, { unaccountedConsumers: ["new-consumer.mjs"] }]) assert.equal(plan(patch).coverage, "full");
});
test("NUL parser accounts for both rename/copy endpoints and deletion old paths, refuses malformed input", () => {
  assert.deepEqual(parseNameStatus(Buffer.from("R100\0old name\0new name\0C50\0source\0copy\0D\0old\0")), [{ status: "R100", paths: ["old name", "new name"] }, { status: "C50", paths: ["source", "copy"] }, { status: "D", paths: ["old"] }]);
  for (const value of ["M\0x", "R100\0old\0", "X\0x\0", "M\0../x\0", "M\0/x\0"]) assert.throws(() => parseNameStatus(Buffer.from(value)));
});
test("pin-only requires whole-file equality except exact official artifact pins and version comments", () => {
  const before = `steps:\n  uses: actions/upload-artifact@${"a".repeat(40)} # v1.0.0\n  with: same\n`;
  const after = before.replace("a".repeat(40), "b".repeat(40)).replace("v1.0.0", "v2.0.0");
  assert.equal(artifactPinOnly(before, after), true);
  for (const changed of [after.replace("b".repeat(40), "v7"), after.replace("upload-artifact", "setup-node"), after.replace("same", "changed"), after + "  run: echo changed\n", after + "# extra comment\n", after.replace("steps:", "permissions:"), after.replace("steps:", "timeout-minutes: 99"), after.split("\n").reverse().join("\n")]) assert.equal(artifactPinOnly(before, changed), false);
});
test("plan digest covers omitted tasks, test roster, N/A reasons and baseline provenance", () => {
  const value = plan();
  const { planDigest, ...semantic } = value;
  assert.equal(digest(semantic), planDigest);
  for (const key of ["notApplicable", "coreTests", "tasks", "baseline"]) assert.notEqual(digest({ ...semantic, [key]: [] }), planDigest);
});
test("independent Git/event rederivation rejects self-consistent forged selection and N/A", async (t) => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const { sourceInput, validatePlan } = await import("../scripts/ci/impact-plan.mjs");
  const root = await mkdtemp(join(tmpdir(), "einzbern-impact-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
  git("init", "--quiet");
  for (const path of ["scripts/ci", "tests", "portal/tests"]) await mkdir(join(root, path), { recursive: true });
  await writeFile(join(root, "scripts/ci/impact-rules.json"), JSON.stringify(rules));
  await writeFile(join(root, "tests/a.test.mjs"), "// synthetic source catalog\n");
  await writeFile(join(root, "portal/tests/a.test.mjs"), "// synthetic Portal catalog\n");
  await writeFile(join(root, "README.md"), "old\n");
  git("add", ".");
  const commit = () => git("-c", "user.name=Fixture", "-c", "user.email=fixture-identity", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture");
  commit();
  const before = git("rev-parse", "HEAD").trim();
  await writeFile(join(root, "README.md"), "new\n");
  git("add", "."); commit();
  const head = git("rev-parse", "HEAD").trim();
  const eventPath = join(root, ".git/event.json");
  await writeFile(eventPath, JSON.stringify({ before, after: head }));
  const env = { GITHUB_EVENT_PATH: eventPath, GITHUB_EVENT_NAME: "push", GITHUB_REPOSITORY: "example/project", GITHUB_RUN_ID: "2", GITHUB_RUN_ATTEMPT: "1" };
  const input = sourceInput(root, env);
  const genuine = createPlan(input, rules, digest(JSON.stringify(rules)));
  assert.deepEqual(validatePlan(genuine, root, env), genuine);
  for (const patch of [{ coreTests: [] }, { notApplicable: [{ task: "core", rule: "skipped" }] }, { tasks: [] }, { tree: "d".repeat(40) }]) {
    const forged = { ...genuine, ...patch }; delete forged.planDigest; forged.planDigest = digest(forged);
    assert.throws(() => validatePlan(forged, root, env));
  }
});

test("document reader audit includes staged additions and immutable baseline readers", async (t) => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const { sourceInput, checkConsumers } = await import("../scripts/ci/impact-plan.mjs");
  const root = await mkdtemp(join(tmpdir(), "einzbern-doc-readers-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
  git("init", "--quiet");
  for (const path of ["scripts/ci", "tests", "portal/tests"]) await mkdir(join(root, path), { recursive: true });
  const audited = { ...rules, docs: { "README.md": ["tests/a.test.mjs"] }, ciTests: ["tests/a.test.mjs"], consumers: { privacy: [], portal: [] }, documentConsumers: { "README.md": "README.md" }, documentAudit: { readers: [], tests: ["tests/a.test.mjs"] } };
  await writeFile(join(root, "scripts/ci/impact-rules.json"), JSON.stringify(audited));
  for (const file of ["tests/a.test.mjs", "tests/b.test.mjs", "portal/tests/a.test.mjs"]) await writeFile(join(root, file), "// tiny harmless catalog\n");
  await writeFile(join(root, "README.md"), "old\n");
  const commit = () => { git("add", "."); git("-c", "user.name=Fixture", "-c", "user.email=fixture-identity", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture"); };
  commit(); const before = git("rev-parse", "HEAD").trim();
  await writeFile(join(root, "README.md"), "new\n"); commit();
  const head = git("rev-parse", "HEAD").trim();
  const input = sourceInput(root, { GITHUB_EVENT_NAME: "push", GITHUB_REPOSITORY: "example/project", GITHUB_RUN_ID: "2", GITHUB_RUN_ATTEMPT: "1" }, { before, after: head });
  input.baseline = { ...baseline, sha: before };
  assert.deepEqual(checkConsumers(root, audited), []);
  assert.equal(createPlan(input, audited, digest(audited)).coverage, "selective");
  await writeFile(join(root, "tests/new-reader.test.mjs"), 'import { readFileSync } from "node:fs"; readFileSync("README.md");\n');
  git("add", "tests/new-reader.test.mjs");
  input.unaccountedConsumers = checkConsumers(root, audited);
  assert.deepEqual(input.unaccountedConsumers, ["tests/new-reader.test.mjs"]);
  assert.equal(createPlan(input, audited, digest(audited)).coverage, "full");
  assert.deepEqual(checkConsumers(root, audited, head), []);
  commit();
  assert.deepEqual(checkConsumers(root, audited, "HEAD"), ["tests/new-reader.test.mjs"]);
});
