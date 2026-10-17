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
                          node_bin=str(base / "bin"), evidence=str(base / "evidence"), mode=mode)
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
