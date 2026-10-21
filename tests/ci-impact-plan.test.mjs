// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPlan, artifactPinOnly, parseNameStatus, digest, sourceInput, validatePlan, checkConsumers, loadRules } from "../scripts/ci/impact-plan.mjs";
import { createCiComponentFixture, fixturePlan, writeFixtureFile } from "./helpers/ci-component-fixture.mjs";
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
test("independent Git/event rederivation admits genuine full and selective plans before resealed forgeries", async (t) => {
  const fixture = await createCiComponentFixture(t);
  for (const coverage of ["full", "selective"]) {
    const genuine = fixturePlan(fixture, coverage);
    assert.equal(genuine.coverage, coverage);
    assert.deepEqual(checkConsumers(fixture.repo, fixture.rules), []);
    assert.deepEqual(checkConsumers(fixture.repo, fixture.rules, fixture.head), []);
    assert.deepEqual(validatePlan(genuine, fixture.repo, fixture.env), genuine);
    const planPath = join(fixture.directory, `plan-${coverage}.json`);
    const immutable = () => {
      return spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/ci/impact-plan.mjs", import.meta.url)), "validate-baseline", planPath], { cwd: fixture.repo, env: fixture.env, encoding: "utf8" });
    };
    await writeFile(planPath, JSON.stringify(genuine));
    const accepted = immutable();
    assert.equal(accepted.status, 0, accepted.stderr);
    for (const patch of [
      { coreTests: [] }, { notApplicable: coverage === "full" ? [{ task: "core", rule: "skipped" }] : [] },
      { tasks: [] }, { head: "d".repeat(40) }, { tree: "d".repeat(40) },
      { rulesHash: "d".repeat(64) }, { sourceCoreTests: [] },
    ]) {
      const forged = { ...genuine, ...patch };
      delete forged.planDigest; forged.planDigest = digest(forged);
      assert.throws(() => validatePlan(forged, fixture.repo, fixture.env), /independently derived/u);
      await writeFile(planPath, JSON.stringify(forged));
      assert.notEqual(immutable().status, 0, "immutable baseline reconstruction also refuses the resealed plan");
    }
    await writeFile(planPath, JSON.stringify(genuine));
    assert.equal(immutable().status, 0, "restored genuine plan remains valid");
  }
});

test("document reader audit includes staged additions and immutable baseline readers", async (t) => {
  const fixture = await createCiComponentFixture(t);
  const { repo: root, git, head, commit, rules: audited } = fixture;
  const input = sourceInput(root, fixture.env);
  input.baseline = { ...baseline, sha: fixture.before };
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

test("tracked Python document readers and their Node consumers cannot be marked N/A", async (t) => {
  const fixture = await createCiComponentFixture(t, { files: {
    "scripts/read-doc.py": 'from pathlib import Path\nassert Path("README.md").read_text().strip() == "old"\n',
    "tests/b.test.mjs": 'import test from "node:test"; import { execFileSync } from "node:child_process"; test("Python document contract", () => execFileSync("python3", ["scripts/read-doc.py"]));\n',
  } });
  const input = sourceInput(fixture.repo, fixture.env);
  assert.deepEqual(input.records, [{ status: "M", paths: ["README.md"] }]);
  assert.equal(input.complete, true);
  assert.equal(fixture.git("status", "--porcelain=v1"), "");
  const declared = fixturePlan(fixture, "selective");
  assert.equal(declared.coverage, "selective");
  assert.ok(declared.coreTests.includes("tests/b.test.mjs"));
  assert.equal(declared.notApplicable.some((row) => row.path === "tests/b.test.mjs"), false);
  const incomplete = structuredClone(fixture.rules);
  incomplete.documentAudit.readers = incomplete.documentAudit.readers.filter((path) => !["scripts/read-doc.py", "tests/b.test.mjs"].includes(path));
  incomplete.documentAudit.tests = incomplete.documentAudit.tests.filter((path) => path !== "tests/b.test.mjs");
  incomplete.docs["README.md"] = ["tests/a.test.mjs"];
  input.baseline = { ...baseline, sha: fixture.before };
  for (const ref of [undefined, fixture.head]) {
    input.unaccountedConsumers = checkConsumers(fixture.repo, incomplete, ref);
    assert.deepEqual(input.unaccountedConsumers, ["scripts/read-doc.py", "tests/b.test.mjs"]);
    assert.equal(createPlan(input, incomplete, digest(incomplete)).coverage, "full");
    assert.deepEqual(checkConsumers(fixture.repo, fixture.rules, ref), []);
  }
  const actual = spawnSync(process.execPath, ["--test", "tests/b.test.mjs"], { cwd: fixture.repo, env: fixture.env, encoding: "utf8" });
  assert.equal(actual.status, 1, "the omitted harmless consumer really detects the changed document");
  assert.match(actual.stdout + actual.stderr, /AssertionError/u);
  assert.equal(fixture.git("status", "--porcelain=v1"), "");
});

test("configuration and previously unknown text reader languages remain conservative", async (t) => {
  const fixture = await createCiComponentFixture(t);
  for (const [reader, text] of [["scripts/reader.py", 'open("README.md").read()\n'], ["tool.yaml", "input: README.md\n"], ["scripts/reader.unknown", 'read_document("README.md")\n']]) {
    await writeFixtureFile(fixture.repo, reader, text);
    fixture.git("add", reader);
    assert.ok(checkConsumers(fixture.repo, fixture.rules).includes(reader), reader);
  }
  const missing = structuredClone(fixture.rules);
  delete missing.documentConsumers["README.md"];
  assert.ok(checkConsumers(fixture.repo, missing).includes("README.md"));
  const absentReader = structuredClone(fixture.rules);
  absentReader.documentAudit.readers.push("scripts/deleted-reader.py");
  assert.ok(checkConsumers(fixture.repo, absentReader).includes("scripts/deleted-reader.py"));
});

function categoryFixtureOptions(category) {
  const inputPath = category === "privacy" ? "scripts/lib/privacy.mjs" : "portal/data.json";
  const oldInput = category === "privacy" ? 'export const value = "old";\n' : '{"value":"old"}\n';
  const reader = `scripts/read-${category}.py`;
  return {
    inputPath, oldInput, changedInput: oldInput.replace("old", "changed"), reader,
    options: {
      rules: { [`${category}Paths`]: [inputPath], [`${category}Tests`]: ["tests/a.test.mjs"] },
      files: {
        [inputPath]: oldInput,
        [reader]: `from pathlib import Path\nassert Path(${JSON.stringify(inputPath)}).read_text() == ${JSON.stringify(oldInput)}\n`,
        "tests/b.test.mjs": `import test from "node:test"; import { execFileSync } from "node:child_process"; test("${category} Python consumer", () => execFileSync("python3", [${JSON.stringify(reader)}]));\n`,
        "tests/c.test.mjs": 'import test from "node:test"; import assert from "node:assert/strict"; test("unrelated sentinel", () => assert.fail("unselected sentinel ran"));\n',
        "portal/tests/nested/all.test.mjs": `import test from "node:test"; import { execFileSync } from "node:child_process"; test("recursive Portal consumer", () => execFileSync("python3", [${JSON.stringify(reader)}]));\n`,
      },
    },
  };
}
async function changeCategoryInput(fixture, contract) {
  fixture.before = fixture.git("rev-parse", "HEAD");
  await writeFixtureFile(fixture.repo, contract.inputPath, contract.changedInput);
  fixture.head = fixture.commit();
  await writeFile(fixture.env.GITHUB_EVENT_PATH, JSON.stringify({ before: fixture.before, after: fixture.head }));
  assert.deepEqual(sourceInput(fixture.repo, fixture.env).records, [{ status: "M", paths: [contract.inputPath] }]);
}

for (const category of ["privacy", "portal"]) {
  test(`${category}-only Python readers select their real root consumers in current and immutable plans`, async (t) => {
    const contract = categoryFixtureOptions(category);
    const fixture = await createCiComponentFixture(t, contract.options);
    const run = (files) => spawnSync(process.execPath, ["--test", ...files], { cwd: fixture.repo, env: fixture.env, encoding: "utf8" });
    const original = run(["tests/b.test.mjs"]);
    assert.equal(original.status, 0, original.stdout + original.stderr);
    await changeCategoryInput(fixture, contract);
    const selected = fixturePlan(fixture, "selective");
    assert.equal(selected.coverage, "selective", "complete audited maps retain genuine selective behavior");
    assert.deepEqual(selected.coreTests, ["tests/a.test.mjs", "tests/b.test.mjs"]);
    assert.equal(selected.notApplicable.some((row) => row.path === "tests/b.test.mjs"), false);
    assert.deepEqual(selected.portalTests, ["portal/tests/a.test.mjs", "portal/tests/nested/all.test.mjs"], "Portal and privacy-dependent Portal consumers retain the whole recursive roster");
    for (const ref of [undefined, fixture.head]) assert.deepEqual(checkConsumers(fixture.repo, fixture.rules, ref), []);
    assert.deepEqual(validatePlan(selected, fixture.repo, fixture.env), selected);
    const planPath = join(fixture.directory, `${category}-genuine.json`);
    await writeFile(planPath, JSON.stringify(selected));
    const immutable = spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/ci/impact-plan.mjs", import.meta.url)), "validate-baseline", planPath], { cwd: fixture.repo, env: fixture.env, encoding: "utf8" });
    assert.equal(immutable.status, 0, immutable.stderr);
    for (const files of [["tests/b.test.mjs"], selected.coreTests, selected.portalTests]) {
      const changed = run(files);
      assert.equal(changed.status, 1, "the actually selected root consumer detects its changed category input");
      assert.match(changed.stdout + changed.stderr, /AssertionError/u);
    }
    try {
      await writeFixtureFile(fixture.repo, contract.inputPath, contract.oldInput);
      const restored = run(["tests/b.test.mjs"]);
      assert.equal(restored.status, 0, restored.stdout + restored.stderr);
    } finally { await writeFixtureFile(fixture.repo, contract.inputPath, contract.changedInput); }
    assert.equal(fixture.git("status", "--porcelain=v1"), "");
  });

  test(`${category} missing reader and missing root-test maps independently force full and reject resealed selection`, async (t) => {
    for (const missing of ["reader", "root-test"]) await t.test(missing, async (context) => {
      const contract = categoryFixtureOptions(category);
      const fixture = await createCiComponentFixture(context, contract.options);
      const incomplete = structuredClone(fixture.rules);
      if (missing === "reader") incomplete.consumers[category] = incomplete.consumers[category].filter((path) => path !== contract.reader);
      else incomplete[`${category}Tests`] = incomplete[`${category}Tests`].filter((path) => path !== "tests/b.test.mjs");
      // The incomplete declaration exists before the category-only edit. A
      // rules-file diff cannot supply a separate reason for the full fallback.
      fixture.rules = incomplete;
      await writeFixtureFile(fixture.repo, "scripts/ci/impact-rules.json", JSON.stringify(incomplete));
      fixture.commit();
      await changeCategoryInput(fixture, contract);
      const { rulesHash } = loadRules(fixture.repo);
      const input = sourceInput(fixture.repo, fixture.env);
      input.baseline = { ...baseline, sha: fixture.before };
      const expectedUnknown = [missing === "reader" ? contract.reader : "tests/b.test.mjs"];
      for (const ref of [undefined, fixture.head]) {
        input.unaccountedConsumers = checkConsumers(fixture.repo, incomplete, ref);
        assert.deepEqual(input.unaccountedConsumers, expectedUnknown);
        const full = createPlan(input, incomplete, rulesHash);
        assert.equal(full.coverage, "full");
        assert.deepEqual(full.reasons, ["unaccounted-consumers"]);
        assert.deepEqual(validatePlan(full, fixture.repo, fixture.env), full);
      }
      const forged = createPlan({ ...input, unaccountedConsumers: [] }, incomplete, rulesHash);
      assert.equal(forged.coverage, "selective", "the forgery is internally sealed but omits the independent audit");
      assert.throws(() => validatePlan(forged, fixture.repo, fixture.env), /independently derived/u);
      const planPath = join(fixture.directory, `${category}-${missing}.json`);
      const immutable = () => spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/ci/impact-plan.mjs", import.meta.url)), "validate-baseline", planPath], { cwd: fixture.repo, env: fixture.env, encoding: "utf8" });
      await writeFile(planPath, JSON.stringify(fixturePlan(fixture, "selective")));
      assert.equal(immutable().status, 0, "the genuine conservative full plan remains reconstructible");
      await writeFile(planPath, JSON.stringify(forged));
      assert.notEqual(immutable().status, 0, "immutable Git bytes independently refuse the resealed selective forgery");
      assert.equal(fixture.git("status", "--porcelain=v1"), "");
    });
  });

  test(`${category} staged configuration and unknown-language callers, stale and unresolved inputs stay conservative`, async (t) => {
    const contract = categoryFixtureOptions(category);
    const fixture = await createCiComponentFixture(t, contract.options);
    const input = sourceInput(fixture.repo, fixture.env);
    input.baseline = { ...baseline, sha: fixture.before };
    for (const [reader, text] of [
      [`scripts/${category}-config.yaml`, `input: ${contract.inputPath}\n`],
      [`scripts/${category}-new.unknown`, `read_input(${JSON.stringify(contract.inputPath)})\n`],
      [`scripts/${category}-new.py`, `open(${JSON.stringify(contract.inputPath)}).read()\n`],
    ]) {
      const caller = `tests/${reader.split("/").at(-1)}.test.mjs`;
      await writeFixtureFile(fixture.repo, reader, text);
      await writeFixtureFile(fixture.repo, caller, `import test from "node:test"; test("configuration caller", () => {}); const input = ${JSON.stringify(reader)};\n`);
      fixture.git("add", reader, caller);
      const unknown = checkConsumers(fixture.repo, fixture.rules);
      assert.ok(unknown.includes(reader), reader);
      assert.ok(unknown.includes(caller), caller);
      assert.equal(createPlan({ ...input, unaccountedConsumers: unknown }, fixture.rules, digest(fixture.rules)).coverage, "full");
    }
    assert.deepEqual(checkConsumers(fixture.repo, fixture.rules, fixture.head), [], "staged additions do not alter the immutable source view");
    const addedHead = fixture.commit();
    assert.deepEqual(checkConsumers(fixture.repo, fixture.rules), checkConsumers(fixture.repo, fixture.rules, addedHead));
    const binary = `scripts/${category}-binary.unknown`;
    await writeFixtureFile(fixture.repo, binary, Buffer.from([0xff, 0]));
    fixture.git("add", binary);
    assert.ok(checkConsumers(fixture.repo, fixture.rules).includes(binary));
    const unreadable = `scripts/${category}-unreadable.unknown`;
    const retained = join(fixture.directory, `${category}-retained-input`);
    await writeFixtureFile(fixture.repo, unreadable, "tracked input\n");
    fixture.git("add", unreadable);
    await rename(join(fixture.repo, unreadable), retained);
    try { assert.ok(checkConsumers(fixture.repo, fixture.rules).includes(unreadable)); }
    finally { await rename(retained, join(fixture.repo, unreadable)); }
    const unresolvedHead = fixture.commit();
    for (const ref of [undefined, unresolvedHead]) {
      const unknown = checkConsumers(fixture.repo, fixture.rules, ref);
      assert.ok(unknown.includes(binary));
      assert.equal(createPlan({ ...input, unaccountedConsumers: unknown }, fixture.rules, digest(fixture.rules)).coverage, "full");
      const stale = structuredClone(fixture.rules);
      stale.consumers[category].push("scripts/deleted-category-reader.py", unreadable);
      const staleUnknown = checkConsumers(fixture.repo, stale, ref);
      assert.ok(staleUnknown.includes("scripts/deleted-category-reader.py"));
      assert.ok(staleUnknown.includes(unreadable), "a present text file that is no longer a category reader is stale too");
      const absent = structuredClone(fixture.rules);
      delete absent.consumers[category];
      assert.ok(checkConsumers(fixture.repo, absent, ref).includes(`${category}-consumer-declaration`));
    }
    assert.equal(fixture.git("status", "--porcelain=v1"), "");
  });
}
