// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const runner = join(root, "scripts/ci/p1-evidence.py");
const loadRunner = `
import importlib.util, json, os, pathlib, sys
spec = importlib.util.spec_from_file_location("p1_evidence", sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
`;

function python(code, args = [], environment = {}) {
  const result = spawnSync("python3", ["-B", "-c", loadRunner + code, runner, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...environment, PYTHONDONTWRITEBYTECODE: "1" },
    timeout: 15_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  return JSON.parse(result.stdout);
}

async function scratch(context) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "einzbern-ci-evidence-")));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

const summary = (prefix = "#", overrides = {}) => {
  const totals = { tests: 3, suites: 1, pass: 2, fail: 0, cancelled: 0, skipped: 1, todo: 0, duration_ms: 1.25, ...overrides };
  return Object.entries(totals).map(([key, value]) => `${prefix} ${key} ${value}`).join("\n") + "\n";
};

test("fixture predicate preserves every original check; injected positive metadata is not a formal preflight", () => {
  const result = python(`
checks = dict(realpathEqual=True, isDirectoryNotSymlink=True, uidMatchesProcess=True,
              symlinksOnPath=[], gitAncestors=[], gitRevParseExit=128)
mutations = {"realpathEqual": False, "isDirectoryNotSymlink": False, "uidMatchesProcess": False,
             "symlinksOnPath": ["fixture-link"], "gitAncestors": ["fixture-git"], "gitRevParseExit": 0}
print(json.dumps({"positiveInjectedOnly": m.fixture_checks_pass(checks),
                  "refusals": [not m.fixture_checks_pass({**checks, key: value}) for key, value in mutations.items()]}))
`);
  assert.equal(result.positiveInjectedOnly, true);
  assert.deepEqual(result.refusals, Array(6).fill(true));
});

test("actual fixture inspection refuses a Git ancestor, symlink path, and regular file", async (context) => {
  const base = await scratch(context);
  const result = python(`
base = pathlib.Path(sys.argv[2])
(base / ".git").mkdir()
(base / "tmp").mkdir()
(base / "link").symlink_to(base / "tmp", target_is_directory=True)
(base / "file").write_text("not a directory")
records = {key: m.fixture_location(base / key) for key in ("tmp", "link", "file")}
print(json.dumps(records))
`, [base]);
  for (const record of Object.values(result)) assert.equal(record.checksPassed, false);
  assert.ok(result.tmp.checks.gitAncestors.includes(base));
  assert.equal(result.link.checks.realpathEqual, false);
  assert.ok(result.link.checks.symlinksOnPath.includes(join(base, "link")));
  assert.equal(result.file.checks.isDirectoryNotSymlink, false);
});

test("exact Node TAP and spec summaries retain observed totals instead of a hard-coded baseline", () => {
  const result = python(`
print(json.dumps([m.parse_test_totals(value.encode()) for value in json.loads(sys.argv[2])]))
`, [JSON.stringify([summary(), summary("ℹ", { tests: 8, pass: 7 })])]);
  assert.deepEqual(result.map(({ tests, pass, skipped, format }) => ({ tests, pass, skipped, format })), [
    { tests: 3, pass: 2, skipped: 1, format: "tap" },
    { tests: 8, pass: 7, skipped: 1, format: "spec" },
  ]);
});

test("missing, truncated, ambiguous, empty, and inconsistent final totals refuse", () => {
  const samples = ["", "all passed\n", summary().replace("# todo 0\n", ""), summary() + summary(),
    summary("#", { tests: 0, pass: 0, skipped: 0 }), summary("#", { tests: 99 })];
  const result = python(`
results = []
for value in json.loads(sys.argv[2]):
    try:
        m.parse_test_totals(value.encode())
        results.append(False)
    except m.Refusal:
        results.append(True)
print(json.dumps(results))
`, [JSON.stringify(samples)]);
  assert.deepEqual(result, samples.map(() => true));
});

test("final P1 JSON is taken only from a complete terminal receipt", () => {
  const result = python(`
valid = b'> pnpm header\\n' + json.dumps(dict(ok=True, reasonCode="P1_VERIFIED")).encode() + b'\\n'
found = m.final_p1_receipt(valid)
refused = []
for data in (b'no receipt', valid + b'trailing unrelated output', b'{"ok":true'):
    try:
        m.final_p1_receipt(data)
        refused.append(False)
    except m.Refusal:
        refused.append(True)
print(json.dumps(dict(found=found, refused=refused)))
`);
  assert.deepEqual(result.found, { ok: true, reasonCode: "P1_VERIFIED" });
  assert.deepEqual(result.refused, [true, true, true]);
});

test("a terminal P1_RED on stderr is retained; conflicting stdout/stderr receipts refuse", () => {
  const result = python(`
red = b'{"ok":false,"reasonCode":"P1_RED","reds":[{"task":"portal"}]}\\n'
stream, found = m.final_receipt(b'pnpm header\\n[ELIFECYCLE] Command failed with exit code 1.\\n', red)
ambiguous = False
try:
    m.final_receipt(b'{"ok":true,"reasonCode":"P1_VERIFIED"}\\n', red)
except m.Refusal:
    ambiguous = True
print(json.dumps(dict(stream=stream, found=found, ambiguous=ambiguous)))
`);
  assert.equal(result.stream, "stderr");
  assert.equal(result.found.reasonCode, "P1_RED");
  assert.deepEqual(result.found.reds, [{ task: "portal" }]);
  assert.equal(result.ambiguous, true);
});

test("CI aggregation requires exact shard coverage, source SHA, run, attempt and passing prerequisites", () => {
  const result = python(`
import copy
spec = importlib.util.spec_from_file_location("aggregate", pathlib.Path(sys.argv[1]).with_name("aggregate-evidence.py"))
a = importlib.util.module_from_spec(spec)
spec.loader.exec_module(a)
plan = dict(shards=dict(checks=["build"], core=["test"], portal=["portal"]),
            prerequisites=dict(checks=[], core=[], portal=["build"]), tasks=["build", "test", "portal"])
def block(tasks):
    return dict(legs=[dict(task=task, ok=True) for task in tasks], reds=[])
records = {}
for shard, tasks in plan["shards"].items():
    records[shard] = dict(mode="p1-" + shard, input=dict(head="a"*40),
                         ciIdentity=dict(GITHUB_RUN_ID="10", GITHUB_RUN_ATTEMPT="2", GITHUB_JOB="p1"),
                         finalShardReceipt={**block(tasks), "prerequisites": block(plan["prerequisites"][shard]),
                                            "extras": block(["test-wiring"] if shard == "checks" else [])})
def judge(value):
    return a.judge_shards(value, plan, "a"*40, "10", "2")
reds = []
for mutation in ("missing", "sha", "attempt", "run", "leg", "cancelled", "prerequisite", "extra"):
    value = copy.deepcopy(records)
    if mutation == "missing": del value["portal"]
    elif mutation == "sha": value["core"]["input"]["head"] = "b"*40
    elif mutation == "attempt": value["core"]["ciIdentity"]["GITHUB_RUN_ATTEMPT"] = "1"
    elif mutation == "run": value["core"]["ciIdentity"]["GITHUB_RUN_ID"] = "11"
    elif mutation == "leg": value["core"]["finalShardReceipt"]["legs"].append(dict(task="test", ok=True))
    elif mutation == "cancelled": value["core"]["finalShardReceipt"]["legs"][0]["ok"] = False
    elif mutation == "extra": value["checks"]["finalShardReceipt"]["extras"]["legs"] = []
    else: value["portal"]["finalShardReceipt"]["prerequisites"]["legs"] = []
    reds.append(bool(judge(value)))
print(json.dumps(dict(green=judge(records), reds=reds)))
`);
  assert.deepEqual(result.green, []);
  assert.deepEqual(result.reds, Array(8).fill(true));
});

test("ordinary full/selective P1 and H1 main retain common summary and failure exits", async (context) => {
  const base = await scratch(context);
  const result = python(`
import contextlib, io
spec = importlib.util.spec_from_file_location("aggregate", pathlib.Path(sys.argv[1]).with_name("aggregate-evidence.py"))
a = importlib.util.module_from_spec(spec); spec.loader.exec_module(a)
base = pathlib.Path(sys.argv[2]); rows = []
# Isolate ordinary main/finalization control flow. Real retained bundle/byte
# validation runs separately through the actual CLI in ci-baseline-evidence.
for coverage in ("full", "selective"):
 for job in ("success", "failure"):
  summary = base / (coverage + "-" + job + ".md")
  os.environ["GITHUB_STEP_SUMMARY"] = str(summary)
  full = coverage == "full"
  plan = dict(coverage=coverage, shards={"checks": ["build"], "core": ["test"], **({"portal": ["portal"]} if full else {})}, tasks=["build", "test", "portal"] if full else ["build", "test"],
              coreTests=["tests/a.test.mjs", "tests/b.test.mjs"] if full else ["tests/a.test.mjs"], sourceCoreTests=["tests/a.test.mjs", "tests/b.test.mjs"],
              portalTests=["portal/tests/a.test.mjs"] if full else [], sourcePortalTests=["portal/tests/a.test.mjs"],
              notApplicable=[] if coverage == "full" else [dict(task="portal", rule="no-portal-impact", affectedPaths=["README.md"])])
  records = {"checks": {}, "core": dict(elapsedSeconds=1.25, testTotals=dict(tests=3))}
  if full: records["portal"] = dict(elapsedSeconds=0.5, testTotals=dict(tests=1))
  a.validate_bundle = lambda *args, **kwargs: (plan, [], records)
  sys.argv = ["aggregate-evidence.py", "--artifacts", str(base), "--sha", "a"*40, "--run-id", "1", "--attempt", "1", "--job-result", job, "--plan-result", "success"]
  output = io.StringIO()
  with contextlib.redirect_stdout(output): status = a.main()
  rows.append(dict(coverage=coverage, job=job, status=status, result=json.loads(output.getvalue()), summary=summary.read_text()))
h1 = base / ("pf2-h1-evidence-" + "a"*40 + "-1"); h1.mkdir()
summary = base / "h1.md"; os.environ["GITHUB_STEP_SUMMARY"] = str(summary)
a.validate_directory = lambda *args: (dict(elapsedSeconds=2.5, testTotals=dict(tests=5), inputManifest=dict(coreTestFiles=["tests/a.test.mjs"])), [])
sys.argv = ["aggregate-evidence.py", "--artifacts", str(base), "--sha", "a"*40, "--run-id", "1", "--attempt", "1", "--job-result", "success", "--mode", "pf2-h1"]
# The H1 branch independently requires its exact artifact directory set.
h1root = base / "h1-artifacts"; h1root.mkdir(); h1.rename(h1root / h1.name)
sys.argv[2] = str(h1root)
output = io.StringIO()
with contextlib.redirect_stdout(output): status = a.main()
print(json.dumps(dict(p1=rows, h1=dict(status=status, result=json.loads(output.getvalue()), summary=summary.read_text()))))
`, [base]);
  for (const row of result.p1) {
    const success = row.job === "success";
    assert.equal(row.status, success ? 0 : 1);
    assert.equal(row.result.ok, success);
    assert.equal(row.result.reasonCode, success ? row.coverage === "full" ? "CI_VERIFIED" : "CI_SELECTED_VERIFIED" : "CI_INCOMPLETE");
    assert.ok(row.summary.includes(`coverage: **${row.coverage}**`));
    assert.ok(row.summary.includes(row.coverage === "full" ? "Selected tasks: 3; Core files: 2 / 2; Portal files: 1 / 1" : "Selected tasks: 2; Core files: 1 / 2; Portal files: 0 / 1"));
    assert.ok(row.summary.includes(`| core | 1.25 | 3 | ${row.coverage === "full" ? 2 : 1} |`));
    assert.match(row.summary, /\| checks \| unknown \| unknown \| n\/a/u);
    assert.equal(row.summary.includes("no-portal-impact"), row.coverage === "selective");
    if (!success) assert.match(row.summary, /Failures:[\s\S]*Plan or selected matrix did not succeed/u);
  }
  assert.equal(result.h1.status, 0);
  assert.equal(result.h1.result.reasonCode, "CI_VERIFIED");
  assert.equal(result.h1.result.mode, "pf2-h1");
  assert.match(result.h1.summary, /literal H1 \(not P1\)/u);
  assert.match(result.h1.summary, /\| pf2-h1 \| 2.5 \| 5 \| 1 \|/u);
});

for (const childExit of [0, 7]) {
  test(`harmless fixture retains whole outer/controller bytes after unlink and preserves child exit ${childExit}`, async (context) => {
    const base = await scratch(context);
    const result = python(`
base = pathlib.Path(sys.argv[2])
tmp = base / "tmp"
evidence = base / "evidence"
tmp.mkdir()
evidence.mkdir()
# Synchronize only this harmless file fixture with real descriptor acquisition.
# No product controller, gate, or lifecycle code is replaced or invoked.
original_observe = m.ControllerObserver.observe
def observed(self):
    original_observe(self)
    if len(self.held) == 2:
        (base / "held").touch()
m.ControllerObserver.observe = observed
child = r'''
import os, pathlib, sys, time
base = pathlib.Path(sys.argv[1]) / "tcrn-test-controller-fixture"
base.mkdir()
(base / "stdout").write_bytes(b"x" * (2 * 1024 * 1024) + b"\\n")
(base / "stderr").write_bytes(b"controller stderr\\x00exact\\n")
os.write(1, b"outer stdout\\x00exact\\n")
os.write(2, b"outer stderr\\n")
deadline = time.monotonic() + 10
while not (base.parent.parent / "held").exists():
    if time.monotonic() >= deadline:
        raise RuntimeError("harmless fixture descriptors were not observed")
    time.sleep(0.01)
with (base / "stdout").open("ab") as stream:
    stream.write(sys.argv[2].encode())
(base / "stdout").unlink()
(base / "stderr").unlink()
base.rmdir()
sys.exit(int(sys.argv[3]))
'''
record = m.capture_process([sys.executable, "-B", "-c", child, str(tmp), sys.argv[3], sys.argv[4]],
                           base, dict(os.environ), tmp, evidence)
print(json.dumps(dict(record=record, wrapperExit=m.wrapper_exit(record["exitCode"], []),
                     entries=list(tmp.iterdir()))))
`, [base, summary(), String(childExit)]);
    assert.equal(result.record.exitCode, childExit);
    assert.equal(result.wrapperExit, childExit);
    assert.deepEqual(result.entries, []);
    assert.deepEqual(result.record.retainedTestControllerOutput.errors, []);
    for (const [name, receipt] of Object.entries({
      "p1.stdout": result.record.stdout,
      "p1.stderr": result.record.stderr,
      "p1-controller.stdout": result.record.retainedTestControllerOutput.files.stdout,
      "p1-controller.stderr": result.record.retainedTestControllerOutput.files.stderr,
    })) {
      const bytes = await readFile(join(base, "evidence", name));
      assert.equal(receipt.bytes, bytes.length);
      assert.equal(receipt.sha256, createHash("sha256").update(bytes).digest("hex"));
    }
    const controller = await readFile(join(base, "evidence/p1-controller.stdout"));
    assert.equal(controller.length, 2 * 1024 * 1024 + 1 + Buffer.byteLength(summary()));
    assert.ok(controller.subarray(-Buffer.byteLength(summary())).equals(Buffer.from(summary())));
    assert.equal((await readFile(join(base, "evidence/p1.stdout"))).toString(), "outer stdout\0exact\n");
  });
}

test("missing controller and symlink controller output remain failed evidence", async (context) => {
  const base = await scratch(context);
  const result = python(`
base = pathlib.Path(sys.argv[2])
tmp = base / "tmp"
evidence = base / "evidence"
tmp.mkdir()
evidence.mkdir()
missing = m.capture_process([sys.executable, "-B", "-c", "print('no controller'); raise SystemExit(3)"],
                            base, dict(os.environ), tmp, evidence)
controller = tmp / "tcrn-test-controller-fixture"
controller.mkdir()
(base / "target").write_bytes(b"must not follow")
(controller / "stdout").symlink_to(base / "target")
(controller / "stderr").write_bytes(b"")
observer = m.ControllerObserver(tmp)
observer.observe()
other = base / "other"
other.mkdir()
retained = observer.retain(other)
print(json.dumps(dict(missing=missing, retained=retained)))
`, [base]);
  assert.equal(result.missing.exitCode, 3);
  assert.deepEqual(result.missing.retainedTestControllerOutput.files, {});
  assert.ok(result.retained.errors.length > 0);
  assert.equal(result.retained.files.stdout, undefined);
});

test("receipt evaluation fails closed for each missing stream, identity, manifest, counts, observation or injected pass", () => {
  const result = python(`
import copy
stream = dict(file="fixture", bytes=0, sha256="a" * 64)
identity = dict(head="b" * 40, tree="c" * 40, branch="fixture", statusPorcelainAll="")
# Deliberately injected metadata tests the predicate only, never formal P1.
valid = dict(errors=[], exitCode=0, fixtures={key: dict(checksPassed=True) for key in ("tmp", "device")},
             input=identity, output=identity, inputManifest={"files": ["fixture"]}, outputManifest={"files": ["fixture"]},
             stdout=stream, stderr=stream,
             retainedTestControllerOutput=dict(errors=[], files=dict(stdout=stream, stderr=stream)),
             retainedArtifactsVerified=True,
             testTotals=dict(tests=1, fail=0, cancelled=0), finalP1Receipt=dict(ok=True, reasonCode="P1_VERIFIED"))
mutations = []
for key in ("stdout", "stderr", "input", "output", "inputManifest", "outputManifest", "testTotals", "retainedArtifactsVerified"):
    changed = copy.deepcopy(valid)
    del changed[key]
    mutations.append(changed)
for key in ("stdout", "stderr"):
    changed = copy.deepcopy(valid)
    del changed["retainedTestControllerOutput"]["files"][key]
    mutations.append(changed)
for key, value in (("exitCode", 4), ("errors", ["read failed"]),
                   ("finalP1Receipt", dict(ok=True, reasonCode="P1_VERIFIED_WITH_INJECTION")),
                   ("output", {**identity, "head": "d" * 40}),
                   ("testTotals", dict(tests=1, fail=1, cancelled=0))):
    mutations.append({**valid, key: value})
changed = copy.deepcopy(valid)
changed["retainedTestControllerOutput"]["errors"] = ["observation failed"]
mutations.append(changed)
changed = copy.deepcopy(valid)
changed["stdout"]["sha256"] = "missing hash"
mutations.append(changed)
print(json.dumps(dict(injectedPredicateOnly=m.evaluate(valid),
                     refused=[bool(m.evaluate(value)) for value in mutations],
                     exits=[m.wrapper_exit(7, ["capture failed"]), m.wrapper_exit(0, ["capture failed"]), m.wrapper_exit(-15, [])])))
`);
  assert.deepEqual(result.injectedPredicateOnly, []);
  assert.ok(result.refused.length >= 16);
  assert.ok(result.refused.every(Boolean));
  assert.deepEqual(result.exits, [7, 1, 143]);
});

test("source manifest uses the real walkFiles roster and separates test-file count from individual totals", () => {
  const result = python(`
manifest = m.source_manifest(pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3]), dict(os.environ))
expected = [row["path"] for row in manifest["files"] if row["path"].startswith("tests/") and row["path"].endswith(".test.mjs")]
print(json.dumps(dict(count=manifest["coreTestFileCount"], files=manifest["coreTestFiles"], agrees=expected == manifest["coreTestFiles"])))
`, [root, process.execPath]);
  assert.equal(result.agrees, true);
  assert.equal(result.count, result.files.length);
  assert.ok(result.files.includes("tests/ci-evidence-retention.test.mjs"));
  assert.equal(result.files.some((path) => path.startsWith("portal/")), false);
});

test("final reread verifies all seven artifact byte streams and refuses tampering, missing files, or divergent JSON", async (context) => {
  const base = await scratch(context);
  const result = python(`
base = pathlib.Path(sys.argv[2])
meta = dict(fixtures={"fixture": "injected component data only"}, inputManifest={"files": ["fixture"]}, outputManifest={"files": ["fixture"]},
            artifactFiles={}, retainedTestControllerOutput={"files": {}})
for name, key in (("fixture-location.json", "fixtures"), ("source-before.json", "inputManifest"), ("source-after.json", "outputManifest")):
    m.write_json(base / name, meta[key])
    meta["artifactFiles"][name] = m.file_receipt(base / name)
for kind in ("stdout", "stderr"):
    for controller in (False, True):
        name = ("p1-controller." if controller else "p1.") + kind
        (base / name).write_bytes((name + "\\n").encode())
        record = m.file_receipt(base / name)
        if controller:
            meta["retainedTestControllerOutput"]["files"][kind] = record
        else:
            meta[kind] = record
positive = m.verify_retained_artifacts(base, meta)
tampered, missing = [], []
for path in sorted(base.iterdir()):
    original = path.read_bytes()
    path.write_bytes(b"tampered" + original)
    tampered.append(bool(m.verify_retained_artifacts(base, meta)))
    path.unlink()
    missing.append(bool(m.verify_retained_artifacts(base, meta)))
    path.write_bytes(original)
meta["inputManifest"] = {"files": ["changed metadata"]}
print(json.dumps(dict(positive=positive, tampered=tampered, missing=missing,
                     divergent=bool(m.verify_retained_artifacts(base, meta)))))
`, [base]);
  assert.deepEqual(result.positive, []);
  assert.deepEqual(result.tampered, Array(7).fill(true));
  assert.deepEqual(result.missing, Array(7).fill(true));
  assert.equal(result.divergent, true);
});

test("CLI retains actual preflight refusal, does not launch P1, omits secrets and never overwrites evidence", async (context) => {
  const base = await scratch(context);
  await Promise.all(["tmp", "device", ".git"].map((name) => mkdir(join(base, name))));
  const evidence = join(base, "evidence");
  const args = ["-B", runner, "--repo", await realpath(root), "--evidence", evidence,
    "--tmp", join(base, "tmp"), "--device", join(base, "device"), "--node-bin", dirname(process.execPath)];
  const env = { ...process.env, DO_NOT_RECORD_SECRET_KEY: "must-not-appear-in-metadata", PYTHONDONTWRITEBYTECODE: "1" };
  const first = spawnSync("python3", args, { encoding: "utf8", env, timeout: 10_000 });
  assert.equal(first.status, 1, first.stderr);
  const receipt = JSON.parse(first.stdout);
  assert.equal(receipt.ok, false);
  assert.equal(receipt.childExitCode, null);
  assert.match(receipt.failures.join("\n"), /fixture preflight refused/u);
  const metadata = await readFile(join(evidence, "p1.meta.json"), "utf8");
  assert.equal(metadata.includes("DO_NOT_RECORD_SECRET_KEY"), false);
  assert.equal(metadata.includes("must-not-appear-in-metadata"), false);
  assert.equal(JSON.parse(metadata).argv, undefined);
  await writeFile(join(evidence, "sentinel"), "retained");
  const second = spawnSync("python3", args, { encoding: "utf8", env, timeout: 10_000 });
  assert.equal(second.status, 1);
  assert.equal(await readFile(join(evidence, "p1.meta.json"), "utf8"), metadata);
  assert.equal(await readFile(join(evidence, "sentinel"), "utf8"), "retained");
});

for (const mode of ["p1", "pf2-h1"]) {
  test(`${mode} component orchestration selects one exact command, correct receipt and fresh evidence only`, async (context) => {
    const base = await scratch(context);
    const result = python(`
import argparse, contextlib, io
base = pathlib.Path(sys.argv[2])
mode = sys.argv[3]
config = m.mode_config(mode)
repo = base / "repo"
repo.mkdir()
(repo / ".git").mkdir()
for name in ("tmp", "device", "bin"):
    (base / name).mkdir()
args = argparse.Namespace(repo=str(repo), tmp=str(base / "tmp"), device=str(base / "device"),
                          node_bin=str(base / "bin"), evidence=str(base / "evidence"), mode=mode, plan=None)
# Injected component orchestration only: never an actual formal fixture or product test run.
m.arguments = lambda: args
m.fixture_location = lambda path: dict(checksPassed=True, checks=dict(entriesAtRecord=[]))
m.identity = lambda repo: dict(head="a" * 40, tree="b" * 40, branch="fixture", statusPorcelainAll="")
m.source_manifest = lambda *args: dict(files=["fixture"], coreTestFiles=["tests/fixture.test.mjs"], coreTestFileCount=1)
m.shutil.which = lambda name, **kwargs: "/tools/" + name
m.checked_output = lambda argv, **kwargs: (m.NODE_VERSION if argv[0].endswith("/node") else
    m.COREPACK_VERSION if argv == ["/tools/corepack", "--version"] else m.PNPM_VERSION)
m.leftovers = lambda path: []
m.time.sleep = lambda seconds: None
calls = []
def capture(argv, repo, env, tmp, evidence, label):
    calls.append(dict(argv=argv, offline=env["COREPACK_ENABLE_NETWORK"], label=label))
    retained = dict(errors=[], files={})
    record = dict(exitCode=0, errors=[], retainedTestControllerOutput=retained)
    final = dict(ok=True, reasonCode=config["expected"], tests=["tests/fixture.test.mjs"])
    for kind in ("stdout", "stderr"):
        outer = evidence / f"{label}.{kind}"
        outer.write_text(json.dumps(final) if kind == "stdout" else "")
        record[kind] = m.file_receipt(outer)
        controller = evidence / f"{label}-controller.{kind}"
        controller.write_text(sys.argv[4] if kind == "stdout" else "")
        retained["files"][kind] = m.file_receipt(controller)
    return record
m.capture_process = capture
with contextlib.redirect_stdout(io.StringIO()):
    status = m.main()
meta = json.loads((base / "evidence" / (config["label"] + ".meta.json")).read_text())
refused = False
try:
    m.main()
except FileExistsError:
    refused = True
wrong = {**meta, config["receiptKey"]: dict(ok=True, reasonCode="TESTS_VERIFIED" if mode == "p1" else "P1_VERIFIED")}
negatives = [bool(m.evaluate(wrong)), bool(m.evaluate({**meta, "exitCode": 9}))]
args.plan = str(base / "forbidden-plan.json")
args.evidence = str(base / "forbidden-plan")
with contextlib.redirect_stdout(io.StringIO()):
    forbidden_status = m.main()
forbidden = json.loads((pathlib.Path(args.evidence) / (config["label"] + ".meta.json")).read_text())
negatives.append(forbidden_status == 1 and "argv" not in forbidden)
args.plan = None
if mode == "pf2-h1":
    for key in ("leftoversBefore", "leftoversAfter"):
        negatives.extend([bool(m.evaluate({**meta, key: None})), bool(m.evaluate({**meta, key: ["123 task.mjs"]}))])
    negatives.append(bool(m.evaluate({**meta, config["receiptKey"]: dict(ok=True, reasonCode="TESTS_VERIFIED", tests=[])})))
    args.evidence = str(base / "shadowed-corepack")
    m.checked_output = lambda argv, **kwargs: m.NODE_VERSION if argv[0].endswith("/node") else "0.0.0"
    with contextlib.redirect_stdout(io.StringIO()):
        shadowed_status = m.main()
    shadowed = json.loads((pathlib.Path(args.evidence) / "h1.meta.json").read_text())
    negatives.append(shadowed_status == 1 and "argv" not in shadowed
                     and any("Pinned Corepack" in error for error in shadowed["errors"]))
print(json.dumps(dict(status=status, calls=calls, refused=refused, meta=meta, negatives=negatives)))
`, [base, mode, summary()]);
    assert.equal(result.status, 0);
    assert.equal(result.calls.length, 1, "one core train only, no second execution on an occupied evidence directory");
    assert.deepEqual(result.calls[0].argv, mode === "pf2-h1"
      ? ["/tools/corepack", "pnpm@11.3.0", "-C", join(base, "repo"), "run", "test"]
      : ["/tools/pnpm", "-C", join(base, "repo"), "run", "verify:p1"]);
    assert.equal(result.calls[0].offline, "0");
    assert.equal(result.meta.stdin, "/dev/null");
    if (mode === "pf2-h1") {
      assert.equal(result.meta.corepackVersion, "0.34.6");
      assert.equal(result.meta.corepackRealpath, "/tools/corepack");
    }
    assert.equal(result.refused, true);
    assert.ok(result.negatives.every(Boolean));
    assert.equal(result.meta.receipt.reasonCode, mode === "pf2-h1" ? "PF2_H1_EVIDENCE_RETAINED" : "CI_P1_EVIDENCE_RETAINED");
  });
}

test("H1 process observations preserve original marks while excluding observer and ps rows", () => {
  const result = python(`
rows = ["1 0 1 node /fixture/tmp/worker", "2 0 2 node tcrn-workflow/scripts/x", "3 0 3 node tcrn-test-controller",
        "4 0 4 node task.mjs", "5 0 5 python d1-runner.py /fixture/tmp", "6 0 6 python p1-evidence.py /fixture/tmp",
        "7 0 7 ps -axo /fixture/tmp", "8 0 8 unrelated"]
print(json.dumps(m.filter_leftovers(rows, "/fixture/tmp")))
`);
  assert.equal(result.length, 4);
  assert.deepEqual(result.map((row) => row.split(" ")[0]), ["1", "2", "3", "4"]);
});

test("selected aggregation rejects forged plan identity, digest, N/A, duplicates and incomplete full rosters", () => {
  const modulePath = join(root, "scripts/ci/aggregate-evidence.py");
  const code = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("aggregate", sys.argv[1]); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
p = dict(head="a"*40, runId="1", attempt="1", coverage="full", shards={"checks":[],"core":["test"],"portal":["portal"]}, sourceCoreTests=["tests/a.test.mjs"],sourcePortalTests=["portal/tests/a.test.mjs"],coreTests=["tests/a.test.mjs"],portalTests=["portal/tests/a.test.mjs"],notApplicable=[])
p["planDigest"] = m.canonical_digest(p)
results = [m.validate_plan_shape(p,"a"*40,"1","1")]
for patch in [dict(head="b"*40), dict(runId="2"), dict(attempt="2"),dict(planDigest="0"*64),dict(notApplicable=[{"task":"core","rule":"skipped"}]),dict(coreTests=[]),dict(coreTests=["tests/a.test.mjs"]*2),dict(coverage="unknown")]:
 results.append(m.validate_plan_shape({**p,**patch},"a"*40,"1","1"))
print(json.dumps(results))
`;
  const result = spawnSync("python3", ["-B", "-c", code, modulePath], { encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  assert.equal(result.status, 0, result.stderr);
  const [good, ...negative] = JSON.parse(result.stdout);
  assert.deepEqual(good, []);
  for (const errors of negative) assert.ok(errors.length > 0);
});

test("retained impact plan requires its own bound bytes even when JSON semantics are identical", async (context) => {
  const base = await scratch(context);
  const result = python(`
base = pathlib.Path(sys.argv[2])
meta = dict(mode="p1-checks", artifactFiles={}, extraArtifacts={}, impactPlan={"coverage": "selective"}, fixtures={}, inputManifest={}, outputManifest={})
for name, value in (("fixture-location.json", {}), ("source-before.json", {}), ("source-after.json", {}), ("impact-plan.json", meta["impactPlan"])):
    (base / name).write_text(json.dumps(value, indent=2) + "\\n")
    meta["artifactFiles"][name] = m.file_receipt(base / name)
for kind in ("stdout", "stderr"):
    name = "p1-checks." + kind
    (base / name).write_text("")
    meta[kind] = m.file_receipt(base / name)
positive = m.verify_retained_artifacts(base, meta)
original = (base / "impact-plan.json").read_bytes()
(base / "impact-plan.json").write_text(json.dumps(meta["impactPlan"], separators=(",", ":")))
same_json = json.loads((base / "impact-plan.json").read_text()) == meta["impactPlan"]
changed_bytes = m.verify_retained_artifacts(base, meta)
(base / "impact-plan.json").write_bytes(original)
receipt = meta["artifactFiles"].pop("impact-plan.json")
missing_receipt = m.verify_retained_artifacts(base, meta)
meta["artifactFiles"]["impact-plan.json"] = {**receipt, "sha256": "0" * 64}
wrong_digest = m.verify_retained_artifacts(base, meta)
meta["artifactFiles"]["impact-plan.json"] = {**receipt, "file": "other.json"}
wrong_binding = m.verify_retained_artifacts(base, meta)
meta["artifactFiles"]["impact-plan.json"] = receipt
(base / "impact-plan.json").unlink()
missing_file = m.verify_retained_artifacts(base, meta)
print(json.dumps(dict(positive=positive, sameJson=same_json, negatives=[changed_bytes, missing_receipt, wrong_digest, wrong_binding, missing_file])))
`, [base]);
  assert.deepEqual(result.positive, []);
  assert.equal(result.sameJson, true);
  for (const failures of result.negatives) assert.ok(failures.some((value) => value.includes("impact-plan.json")));
});
