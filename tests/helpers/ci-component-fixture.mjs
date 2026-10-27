// SPDX-License-Identifier: Apache-2.0
// Owned, canonical component sources. Production scripts are copied byte for
// byte; only the tiny source roster and its explicit audit are fixture inputs.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createPlan, sourceInput, loadRules, checkConsumers, documentReaderClosure, documentReaderSources, categoryReaderAudit, categoryInputAudit, sourceDependencyGraph, sourceAuditDigest } from "../../scripts/ci/impact-plan.mjs";
import { privateHeavyEnvironment, heavyLockDirectoryUnder } from "./heavy-slots.mjs";

export const componentSourceRoot = resolve(import.meta.dirname, "../..");
const sorted = (items) => [...new Set(items)].sort();

export async function writeFixtureFile(repo, path, bytes) {
  await mkdir(dirname(join(repo, path)), { recursive: true });
  await writeFile(join(repo, path), bytes);
}

// This is fixture construction, never a runtime planner declaration update.
export async function freezeTinyRules(repo, rules) {
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  await writeFixtureFile(repo, "scripts/ci/impact-rules.json", JSON.stringify(rules));
  git("add", ".");
  const { texts, unresolved } = documentReaderSources(repo);
  assert.deepEqual(unresolved, []);
  rules.sourceAudit = Object.fromEntries([...texts].filter(([path]) => path !== "scripts/ci/impact-rules.json").map(([path, text]) => [path, sourceAuditDigest(path, text)]));
  const inputs = new Map([...rules.privacyPaths, ...rules.portalPaths].map((path) => [path, null])), graph = sourceDependencyGraph(texts, inputs);
  rules.categoryInputAudit = categoryInputAudit(texts, rules, inputs);
  rules.documentAudit = {};
  for (const document of Object.keys(rules.docs)) {
    const readers = documentReaderClosure(texts, [document], graph);
    const tests = readers.filter((path) => path.startsWith("tests/") && path.endsWith(".test.mjs"));
    const portalTests = readers.filter((path) => path.startsWith("portal/tests/") && path.endsWith(".test.mjs"));
    rules.docs[document] = sorted([...rules.docs[document], ...tests]);
    rules.documentAudit[document] = { readers, tests: rules.docs[document], portalTests };
  }
  // Freeze documents first: their declaration is itself a tracked configuration
  // reader. Categories use exactly the production source scanner and closure.
  await writeFixtureFile(repo, "scripts/ci/impact-rules.json", JSON.stringify(rules));
  const categorySources = documentReaderSources(repo);
  assert.deepEqual(categorySources.unresolved, []);
  for (const [category, audit] of Object.entries(categoryReaderAudit(categorySources.texts, rules))) {
    rules.consumers[category] = audit.readers;
    rules[`${category}Tests`] = sorted([...rules[`${category}Tests`], ...audit.tests]);
  }
  await writeFixtureFile(repo, "scripts/ci/impact-rules.json", JSON.stringify(rules));
  git("add", ".");
  return rules;
}

// The Node caller is present at review time. Only the category helper gains the
// environment-mediated input later; declarations stay frozen across both edits.
export function environmentDocumentCategoryFixture() {
  const reader = "scripts/privacy-reader.py";
  return {
    reader,
    oldHelper: 'import os\nfrom pathlib import Path\nassert True\n',
    changedHelper: 'import os\nfrom pathlib import Path\nassert Path(os.environ["DOCUMENT_INPUT"]).read_text().strip() == "old"\n',
    options: {
      rules: { privacyPaths: [reader], privacyTests: ["tests/b.test.mjs"] },
      files: {
        [reader]: 'import os\nfrom pathlib import Path\nassert True\n',
        "tests/a.test.mjs": 'import test from "node:test"; import assert from "node:assert/strict"; import { readFileSync } from "node:fs"; test("document remains nonempty", () => assert.ok(readFileSync("README.md", "utf8").length));\n',
        "tests/b.test.mjs": 'import test from "node:test"; import { execFileSync } from "node:child_process"; test("existing privacy helper root", () => execFileSync("python3", ["scripts/privacy-reader.py"], { env: { ...process.env, DOCUMENT_INPUT: "README.md" } }));\n',
      },
    },
  };
}

function harmlessTest(name) {
  return `import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { setTimeout } from "node:timers/promises";
test("component ${name}", async () => {
  await setTimeout(100);
  if (process.env.CI_COMPONENT_OBSERVED) appendFileSync(process.env.CI_COMPONENT_OBSERVED, "${name}\\n");
  assert.notEqual(process.env.CI_COMPONENT_FAIL, "${name}");
});
`;
}

export async function createCiComponentFixture(context, { production = false, files = {}, runId = "71", rules: ruleOverrides = {} } = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "einzbern-ci-component-")));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const repo = join(directory, "repo");
  try {
    await mkdir(repo);
    if (production) {
      await cp(join(componentSourceRoot, "scripts"), join(repo, "scripts"), { recursive: true });
      // Task's imports need the already installed Ajv and TypeScript dependencies.
      // The actual node_modules directory is excluded by the unchanged walker.
      await mkdir(join(repo, "node_modules"));
      for (const dependency of ["ajv", "typescript"]) await symlink(await realpath(join(componentSourceRoot, "node_modules", dependency)), join(repo, "node_modules", dependency), "dir");
    }
    const defaults = {
      "package.json": JSON.stringify({ name: "ci-component", type: "module", private: true }),
      ".gitignore": "dist/\nnode_modules/\n",
      "README.md": "old\n",
      "tests/a.test.mjs": harmlessTest("a"),
      "tests/b.test.mjs": harmlessTest("b"),
      "portal/tests/a.test.mjs": harmlessTest("portal"),
    };
    for (const [path, bytes] of Object.entries({ ...defaults, ...files })) await writeFixtureFile(repo, path, bytes);
    const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
    git("init", "--quiet");
    const commit = () => {
      git("add", ".");
      git("-c", "user.name=Fixture", "-c", "user.email=fixture-identity", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "component source");
      return git("rev-parse", "HEAD");
    };
    const rules = await freezeTinyRules(repo, {
      version: 1, docs: { "README.md": ["tests/a.test.mjs"] }, ciTests: ["tests/a.test.mjs"],
      privacyPaths: [], privacyTests: [], portalPaths: [], portalTests: [],
      consumers: { privacy: [], portal: [] }, documentConsumers: { "README.md": "README.md" },
      ...ruleOverrides,
    });
    const before = commit();
    await writeFixtureFile(repo, "README.md", "new\n");
    const head = commit();
    const eventPath = join(repo, ".git/event.json");
    await writeFile(eventPath, JSON.stringify({ before, after: head }));
    const env = privateHeavyEnvironment(heavyLockDirectoryUnder(directory), {
      ...process.env, GITHUB_EVENT_PATH: eventPath, GITHUB_EVENT_NAME: "push", GITHUB_REPOSITORY: "example/project",
      GITHUB_RUN_ID: runId, GITHUB_RUN_ATTEMPT: "1", TMPDIR: directory,
      EINZBERN_HOME: join(directory, "device"), EINZBERN_TEST_DEVICE_ROOT: join(directory, "devices"),
      CI_COMPONENT_OBSERVED: join(directory, "observed.txt"),
    });
    delete env.NODE_TEST_CONTEXT;
    assert.equal(git("status", "--porcelain=v1", "--untracked-files=all"), "");
    return { directory, repo, before, head, env, rules, git, commit };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export function fixturePlan(fixture, coverage) {
  const input = sourceInput(fixture.repo, fixture.env);
  if (coverage === "selective") input.baseline = {
    state: "verified", repository: "example/project", sha: fixture.before, coverage: "full",
    verification: "CI_VERIFIED", conclusion: "success", runId: "1", attempt: "1",
    workflow: ".github/workflows/ci.yml", evidenceDigest: "1".repeat(64),
  }; // Explicit classification input, not evidence of a hosted baseline.
  input.unaccountedConsumers = checkConsumers(fixture.repo, fixture.rules);
  const { rules, rulesHash } = loadRules(fixture.repo);
  return createPlan(input, rules, rulesHash);
}

export async function withFixtureEnvironment(values, action) {
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  try { return await action(); }
  finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

export function runFixtureTask(fixture, args, overrides = {}) {
  // Keep NODE_OPTIONS intact. The existing sealed policy recognizes this real
  // task entrypoint and handles its controller lifetime itself.
  return spawnSync(process.execPath, [join(fixture.repo, "scripts/task.mjs"), ...args], {
    cwd: fixture.repo, env: { ...fixture.env, ...overrides }, encoding: "utf8", timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
  });
}

export async function captureFixtureCore(fixture, plan, evidence, overrides = {}) {
  const temporary = join(fixture.directory, `capture-tmp-${plan.coverage}`);
  const device = join(fixture.directory, `capture-device-${plan.coverage}`);
  const planPath = join(fixture.directory, `execution-plan-${plan.coverage}.json`);
  await mkdir(temporary); await mkdir(device); await mkdir(evidence, { recursive: true });
  await writeFile(planPath, JSON.stringify(plan));
  const env = { ...fixture.env, ...overrides, TMPDIR: temporary, EINZBERN_HOME: join(device, "einzbern"), EINZBERN_TEST_DEVICE_ROOT: device, EINZBERN_CI_EVIDENCE_DIR: evidence, GITHUB_JOB: "p1" };
  // Use the production read-only FD observer. Neither its child policy nor the
  // controller/reaper is changed to make this fixture run.
  const program = `
import importlib.util,json,pathlib,os,sys
repo=pathlib.Path(sys.argv[1]);node=sys.argv[2];plan=sys.argv[3];tmp=sys.argv[4];device=sys.argv[5];evidence=sys.argv[6]
spec=importlib.util.spec_from_file_location("capture",repo/"scripts/ci/p1-evidence.py")
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
env=dict(os.environ)
before=m.identity(repo);manifest=m.source_manifest(repo,node,env)
fixtures={"tmp":m.fixture_location(tmp),"device":m.fixture_location(device)}
if not all(f["checksPassed"] for f in fixtures.values()): raise RuntimeError("CI_COMPONENT_FIXTURE_PREFLIGHT_REFUSED: "+json.dumps(fixtures,sort_keys=True))
record=m.capture_process([node,str(repo/"scripts/ci/p1-shard.mjs"),"core",plan],repo,env,tmp,evidence,"p1-core")
print(json.dumps(dict(capture=record,input=before,output=m.identity(repo),inputManifest=manifest,outputManifest=m.source_manifest(repo,node,env),fixtures=fixtures)))
`;
  const capture = JSON.parse(execFileSync("python3", ["-B", "-c", program, fixture.repo, process.execPath, planPath, temporary, device, evidence], {
    cwd: fixture.repo, env, encoding: "utf8", timeout: 45_000, maxBuffer: 8 * 1024 * 1024,
  }));
  const step = JSON.parse(await readFile(join(evidence, "steps/leg-test.json"), "utf8"));
  const taskStreams = await Promise.all(["stdout", "stderr"].map((kind) => readFile(join(evidence, `steps/leg-test.${kind}`), "utf8")));
  const task = JSON.parse((step.exitCode === 0 ? taskStreams[0] : taskStreams[1]).trim());
  const shard = JSON.parse(await readFile(join(evidence, "shard.json"), "utf8"));
  return { ...capture, step, task, shard, taskStreams, planPath, temporary, evidence };
}

export async function createOfflineScannerFixture(context, { unexpectedSource = false, extraInstallerFetch = false, baselineMutation = null, harnessMutation = null, nativeIpcMutation = null } = {}) {
  const temporaryRoot = await realpath(await mkdtemp(join(tmpdir(), "einzbern-offline-scan-")));
  context?.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const root = join(temporaryRoot, "engine");
  try {
    await mkdir(join(root, ".git"), { recursive: true });
    await cp(join(componentSourceRoot, "scripts"), join(root, "scripts"), { recursive: true });
    for (const path of ["skill/mana-orchestrate/scripts/install.mjs", "tests/offline-boundary.test.mjs", "tests/helpers/ci-component-fixture.mjs", "tests/helpers/heavy-slots.mjs", "package.json", ".npmrc", "portal/tests/ui-presence-support.mjs", "portal/tests/disposable-portal-fetch.test.mjs", "portal/tests/helpers/disposable-portal-fetch.mjs"]) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await cp(join(componentSourceRoot, path), join(root, path));
    }
    for (const [path, mutation] of [["scripts/lib/codex-native-hook-ipc.mjs", nativeIpcMutation], ["scripts/ci/baseline-evidence.mjs", baselineMutation], [harnessMutation ? `portal/tests/${harnessMutation.file}` : "", harnessMutation]]) {
      if (!mutation) continue;
      const source = await readFile(join(root, path), "utf8");
      const updated = mutation.replace ? source.replace(...mutation.replace) : `${source}\n${mutation.append}\n`;
      assert.notEqual(updated, source, "scanner mutation must change its intended source site");
      await writeFile(join(root, path), updated);
    }
    await mkdir(join(root, "node_modules"));
    for (const dependency of ["ajv", "typescript"]) await symlink(await realpath(join(componentSourceRoot, "node_modules", dependency)), join(root, "node_modules", dependency), "dir");
    const unexpectedRequest = ["await f", 'etch("https://example.invalid");\n'].join("");
    if (unexpectedSource) await writeFile(join(root, "scripts/unexpected-network.mjs"), unexpectedRequest);
    if (extraInstallerFetch) {
      const installer = join(root, "skill/mana-orchestrate/scripts/install.mjs");
      await writeFile(installer, `${await readFile(installer, "utf8")}\n${unexpectedRequest}`);
    }
    const env = privateHeavyEnvironment(heavyLockDirectoryUnder(temporaryRoot), { ...process.env, TMPDIR: temporaryRoot, EINZBERN_HOME: join(temporaryRoot, "device"), TCRN_OFFLINE_PROOF: "1" });
    delete env.NODE_TEST_CONTEXT;
    return { root, repo: root, temporaryRoot, directory: temporaryRoot, env };
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}
