// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { verifyBaseline, collectBaseline } from "../scripts/ci/baseline-evidence.mjs";
import { createCiComponentFixture, fixturePlan, captureFixtureCore, withFixtureEnvironment, createOfflineScannerFixture, runFixtureTask, assertOfflineUnixFixturePathBudget, offlineUnixFixtureLayout } from "./helpers/ci-component-fixture.mjs";
const expected = { repository: "example/project", base: "a".repeat(40) };
const full = { state: "verified", repository: expected.repository, sha: expected.base, runId: "1", attempt: "2", workflow: ".github/workflows/ci.yml", conclusion: "success", coverage: "full", verification: "CI_VERIFIED", evidenceDigest: "b".repeat(64) };
test("full and sound selective baseline retain honest coverage; green names alone are insufficient", () => {
  assert.equal(verifyBaseline(full, expected).eligible, true);
  assert.equal(verifyBaseline({ ...full, coverage: "selective", verification: "CI_SELECTED_VERIFIED" }, expected).coverage, "selective");
  for (const patch of [{ coverage: "selective" }, { conclusion: "failure" }, { conclusion: "cancelled" }, { conclusion: "timed_out" }, { sha: "c".repeat(40) }, { workflow: "other.yml" }, { evidenceDigest: null }, { runId: null }, { coverage: "unknown" }, { repository: "other/project" }, { state: "unavailable", reason: "permission" }]) assert.equal(verifyBaseline({ ...full, ...patch }, expected).eligible, false);
  assert.equal(verifyBaseline({ conclusion: "success", name: "verify" }, expected).eligible, false);
});
test("unavailable/zero before cannot manufacture a baseline or stall a full operation", async () => {
  assert.equal(verifyBaseline(null, expected).eligible, false);
  const result = await collectBaseline({ complete: false, comparison: { base: "0".repeat(40) } }, ".");
  assert.equal(result.state, "unavailable");
});
test("API permission, incomplete jobs pagination and unavailable run evidence conservatively fall back", async (t) => {
  onlineContext(t);
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const input = { complete: true, repository: expected.repository, comparison: { base: expected.base } };
  globalThis.fetch = async () => ({ ok: false, status: 403 });
  assert.equal((await collectBaseline(input, ".")).reason, "api-403");
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ workflow_runs: [] }) });
  assert.equal((await collectBaseline(input, ".")).state, "unavailable");
  globalThis.fetch = async (url) => ({ ok: true, json: async () => url.includes("/jobs?") ? { total_count: 101, jobs: [] } : { workflow_runs: [{ id: 1, run_attempt: 1, head_sha: expected.base, path: ".github/workflows/ci.yml", conclusion: "success", event: "push" }] } });
  assert.equal((await collectBaseline(input, ".")).reason, "jobs-incomplete-or-failed");
});

function onlineContext(t) {
  const values = { GITHUB_JOB: "plan", CI: "true", GITHUB_ACTIONS: "true", EINZBERN_CI_BASELINE_ONLINE: "read-only", GITHUB_REPOSITORY: "example/project", GITHUB_WORKFLOW_REF: "example/project/.github/workflows/ci.yml@refs/heads/main", GITHUB_EVENT_NAME: "push" };
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
test("online acquisition requires CI workflow purpose and repository-scoped read endpoints", async (t) => {
  const { githubBaselineRequest } = await import("../scripts/ci/baseline-evidence.mjs");
  onlineContext(t);
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++;
    assert.equal(url, "https://api.github.com/repos/example/project/actions/runs/1");
    assert.equal(options.method, "GET");
    assert.equal(options.headers.Accept, "application/vnd.github+json");
    assert.equal(options.headers["X-GitHub-Api-Version"], "2022-11-28");
    assert.ok(options.signal instanceof AbortSignal);
    return { ok: true, json: async () => ({ id: 1 }) };
  };
  t.after(() => { globalThis.fetch = original; });
  for (const path of ["https://elsewhere.invalid", "../issues", "issues", "actions/runs/1/approve", "actions/runs/1?other=true"]) await assert.rejects(githubBaselineRequest("example/project", path));
  for (const [key, value] of [["GITHUB_JOB", "p1"], ["CI", "false"], ["GITHUB_ACTIONS", "false"], ["EINZBERN_CI_BASELINE_ONLINE", ""], ["GITHUB_EVENT_NAME", "workflow_dispatch"], ["GITHUB_WORKFLOW_REF", "example/project/other.yml@refs/heads/main"]]) {
    const saved = process.env[key]; process.env[key] = value;
    await assert.rejects(githubBaselineRequest("example/project", "actions/runs/1"));
    process.env[key] = saved;
  }
  await assert.rejects(githubBaselineRequest("other/project", "actions/runs/1"));
  assert.equal(calls, 0);
  assert.deepEqual(await githubBaselineRequest("example/project", "actions/runs/1"), { id: 1 });
  assert.equal(calls, 1);
});

test("private Unix fixture budget includes both nested names, UTF-8 bytes and the terminator", () => {
  // Arithmetic only: these boundary strings never select a filesystem root.
  const directory = join("/", "x".repeat(75), `${offlineUnixFixtureLayout.scannerPrefix}${offlineUnixFixtureLayout.suffix}`, `${offlineUnixFixtureLayout.directoryPrefix}${offlineUnixFixtureLayout.suffix}`);
  const budget = assertOfflineUnixFixturePathBudget(directory);
  assert.deepEqual(budget.paths.map(({ relativePath, requiredBytes }) => [relativePath, requiredBytes]), [["h", 98], ["absent", 103], ["link", 101], ["file", 101], ["alias/h", 104]]);
  assert.throws(() => assertOfflineUnixFixturePathBudget(`${directory}x`), /UNIX_FIXTURE_PATH_TOO_LONG/u);
  assert.throws(() => assertOfflineUnixFixturePathBudget(`${directory.slice(0, -1)}界`), /UNIX_FIXTURE_PATH_TOO_LONG/u);
});

// Always registered, including Core's TCRN_OFFLINE_PROOF=1 environment. The real
// offline task invokes only its inner runtime proof, whose recursion guard stays.
for (const [name, options, expectedFinding] of [
  ["reviewed guarded source", {}, null],
  ["changed API host", { baselineMutation: { replace: ["https://api.github.com/repos/", "https://example.invalid/repos/"] } }, "NETWORK_API:scripts/ci/baseline-evidence.mjs"],
  ["changed context guard", { baselineMutation: { replace: ['env.CI !== "true"', 'env.CI === "true"'] } }, "NETWORK_API:scripts/ci/baseline-evidence.mjs"],
  ["changed endpoint", { baselineMutation: { replace: ["actions\\/workflows", "issues\\/workflows"] } }, "NETWORK_API:scripts/ci/baseline-evidence.mjs"],
  ["extra request", { baselineMutation: { append: ["void f", 'etch("https://example.invalid");'].join("") } }, "NETWORK_API:scripts/ci/baseline-evidence.mjs"],
  ["extra network import", { baselineMutation: { append: ['import https from "node:', 'https";'].join("") } }, "NETWORK_MODULE:scripts/ci/baseline-evidence.mjs"],
  ["unrelated module request", { unexpectedSource: true }, "NETWORK_API:scripts/unexpected-network.mjs"],
]) {
  test(`mandatory offline exact-site scanner: ${name}`, async (t) => {
    const fixture = await createOfflineScannerFixture(t, options);
    assert.equal(fixture.env.TMPDIR, fixture.temporaryRoot, "the real child inherits the owned scanner root");
    assert.equal(fixture.unixPathBudget.directory, join(fixture.env.TMPDIR, `${offlineUnixFixtureLayout.directoryPrefix}${offlineUnixFixtureLayout.suffix}`));
    const run = runFixtureTask(fixture, ["offline"]);
    assert.equal(run.status, expectedFinding ? 1 : 0, JSON.stringify({ status: run.status, signal: run.signal, error: run.error?.message, stderr: run.stderr, stdout: run.stdout }));
    const stream = expectedFinding ? run.stderr : run.stdout;
    assert.ok(stream.trim(), "expected structured scanner receipt; stdout=" + run.stdout + "; stderr=" + run.stderr);
    const report = JSON.parse(stream.trim().split("\n").at(-1));
    assert.equal(report.reasonCode, expectedFinding ? "OFFLINE_BOUNDARY_FINDINGS" : "OFFLINE_BOUNDARY_VERIFIED");
    if (expectedFinding) assert.ok(report.error.includes(expectedFinding), report.error);
    else assert.equal(run.stderr, "");
  });
}

// Real aggregate component fixtures: only network transport is mocked. Every
// artifact is a real ZIP; raw streams, receipts, Git bytes and plan are reread.
async function localBundle(t, coverage) {
  const fs = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { execFileSync, spawnSync } = await import("node:child_process");
  const { createTransport } = await import("../scripts/ci/transport-evidence.mjs");
  const fixture = await createCiComponentFixture(t, { production: true });
  const { directory, repo, head } = fixture;
  const bundle = join(directory, "artifacts");
  await fs.mkdir(bundle);
  const plan = fixturePlan(fixture, coverage);
  assert.equal(plan.coverage, coverage);
  const planDir = join(bundle, `plan-evidence-${head}-1`);
  await fs.mkdir(planDir);
  await fs.writeFile(join(planDir, "impact-plan.json"), JSON.stringify(plan, null, 2) + "\n");
  await createTransport(join(planDir, "transport"), plan);
  const core = await captureFixtureCore(fixture, plan, join(bundle, `p1-core-evidence-${head}-1`));
  const program = `
import importlib.util,json,pathlib,sys,hashlib
root=pathlib.Path(sys.argv[1]); repo=pathlib.Path(sys.argv[2]); plan=json.loads(sys.argv[3]); actual=json.loads(sys.argv[4])
spec=importlib.util.spec_from_file_location("aggregate",repo/"scripts/ci/aggregate-evidence.py")
a=importlib.util.module_from_spec(spec);spec.loader.exec_module(a);m=a.evidence_runner
def write(path,value):
 path.parent.mkdir(parents=True,exist_ok=True)
 path.write_text(json.dumps(value,indent=2)+"\\n" if not isinstance(value,str) else value)
def seal(directory,meta,name):
 meta["extraArtifacts"][name]={**m.file_receipt(directory/name),"file":name}
totals="# tests 1\\n# suites 0\\n# pass 1\\n# fail 0\\n# cancelled 0\\n# skipped 0\\n# todo 0\\n# duration_ms 1\\n"
manifest={"files":a.git_source_files(repo,plan["head"]),"coreTestFiles":plan["sourceCoreTests"],"portalTestFiles":plan["sourcePortalTests"]}
identity={"head":plan["head"],"tree":plan["tree"],"branch":"fixture","statusPorcelainAll":""}
for shard,tasks in plan["shards"].items():
 mode="p1-"+shard; d=root/(mode+"-evidence-"+plan["head"]+"-1")
 if shard=="core":
  # These are actual task/shard/controller bytes retained by the production
  # observer, not a printer or synthetic terminal receipt.
  final=json.loads((d/"shard.json").read_text())
  meta=dict(actual["capture"],mode=mode,fixtures=actual["fixtures"],input=actual["input"],output=actual["output"],inputManifest=actual["inputManifest"],outputManifest=actual["outputManifest"],impactPlan=plan,coverage=plan["coverage"],planDigest=plan["planDigest"],selectedCoreTests=plan["coreTests"],ciIdentity={"GITHUB_RUN_ID":"71","GITHUB_RUN_ATTEMPT":"1","GITHUB_JOB":"p1"},artifactFiles={},extraArtifacts={},finalShardReceipt=final,finalReceiptStream="stdout",receipt={"ok":actual["capture"]["exitCode"]==0,"scope":"actual Core child; component wrapper metadata"})
  for name,value in [("fixture-location.json",meta["fixtures"]),("source-before.json",meta["inputManifest"]),("source-after.json",meta["outputManifest"]),("impact-plan.json",plan)]:
   write(d/name,value);meta["artifactFiles"][name]=m.file_receipt(d/name)
  for path in [d/"shard.json",*sorted((d/"steps").iterdir())]: seal(d,meta,str(path.relative_to(d)))
  meta["testTotals"]=m.parse_test_totals((d/(mode+"-controller.stdout")).read_bytes())
  meta["retainedArtifactsVerified"]=not m.verify_retained_artifacts(d,meta)
  write(d/"receipt.json",meta["receipt"]);write(d/(mode+".meta.json"),meta)
  continue
 d.mkdir()
 block=lambda tasks:dict(legs=[dict(task=x,ok=True) for x in tasks],reds=[])
 final=dict(ok=True,reasonCode="P1_SHARD_VERIFIED",shard=shard,coverage=plan["coverage"],planDigest=plan["planDigest"],prerequisites=block(plan["prerequisites"][shard]),extras=block(["test-wiring"] if shard=="checks" else []),**block(tasks))
 fixtures={"tmp":{"checksPassed":True},"device":{"checksPassed":True}}
 meta=dict(mode=mode,exitCode=0,errors=[],fixtures=fixtures,input=identity,output=identity,inputManifest=manifest,outputManifest=manifest,retainedArtifactsVerified=True,impactPlan=plan,coverage=plan["coverage"],planDigest=plan["planDigest"],selectedCoreTests=plan["coreTests"],ciIdentity={"GITHUB_RUN_ID":"71","GITHUB_RUN_ATTEMPT":"1","GITHUB_JOB":"p1"},artifactFiles={},extraArtifacts={},finalShardReceipt=final,finalReceiptStream="stdout",receipt={"ok":True})
 for name,value in [("fixture-location.json",fixtures),("source-before.json",manifest),("source-after.json",manifest),("impact-plan.json",plan)]:
  write(d/name,value);meta["artifactFiles"][name]=m.file_receipt(d/name)
 for kind in ["stdout","stderr"]:
  write(d/(mode+"."+kind),json.dumps(final)+"\\n" if kind=="stdout" else "");meta[kind]=m.file_receipt(d/(mode+"."+kind))
 write(d/"shard.json",final);seal(d,meta,"shard.json")
 for prefix,values in [("leg",tasks),("prerequisite",plan["prerequisites"][shard]),("extra",["test-wiring"] if shard=="checks" else [])]:
  for task in values:
   name="steps/"+prefix+"-"+task
   command=["node","scripts/task.mjs",task]
   output=json.dumps({"ok":True})+"\\n"
   for suffix,value in [(".json",dict(command=command,exitCode=0,signal=None)),(".stdout",output),(".stderr","")]:
    write(d/(name+suffix),value);seal(d,meta,name+suffix)
 if shard=="portal":
  timings=[dict(id=str(i)) for i in range(1,7)]
  for step in timings:
   for suffix,value in [(".json",dict(exitCode=0)),(".stdout",totals if step["id"]=="1" else ""),(".stderr","")]:
    name="portal/"+step["id"]+suffix;write(d/name,value);seal(d,meta,name)
  # validator's functional output path is the production 01 name.
  write(d/"portal/01.stdout",totals);seal(d,meta,"portal/01.stdout")
  for name,value in [("portal/receipt.json",dict(ok=True,timings=timings)),("portal/test-roster.json",plan["sourcePortalTests"])]:
   write(d/name,value);seal(d,meta,name)
  meta["testTotals"]=m.parse_test_totals(totals.encode())
 write(d/"receipt.json",meta["receipt"]);write(d/(mode+".meta.json"),meta)
p=root/("package-smoke-"+plan["head"]+"-1");p.mkdir()
write(p/"source-head.txt",plan["head"]+"\\n")
for name,reason in [("install.json","INSTALL_ENGINE_READY"),("setup-plan.json","SETUP_PLAN_READY"),("setup-applied.json","SETUP_APPLIED"),("doctor.json","DOCTOR_READY"),("init.json","LIBRARY_CREATED"),("status.json","WORKSPACE_COMMAND_COMPLETED"),("commands.json","CLI_CATALOG_READY")]:
 write(p/name,dict(reasonCode=reason,ok=True,checks=[dict(ok=True)]))
(p/"fixture.tar.gz").write_bytes(b"local package validator component bytes")
write(p/"fixture.tar.gz.sha256",hashlib.sha256((p/"fixture.tar.gz").read_bytes()).hexdigest()+" fixture.tar.gz\\n")
write(p/"package-seal.json",dict(identity={k:plan[k] for k in ["head","runId","attempt","planDigest"]},files={x.name:dict(bytes=x.stat().st_size,sha256=hashlib.sha256(x.read_bytes()).hexdigest()) for x in p.iterdir()}))
`;
  execFileSync("python3", ["-B", "-c", program, bundle, repo, JSON.stringify(plan), JSON.stringify(core)], { env: fixture.env, maxBuffer: 8 * 1024 * 1024 });
  const aggregate = () => {
    const summaryPath = join(directory, "aggregate-summary.md");
    writeFileSync(summaryPath, "");
    const run = spawnSync("python3", ["-B", join(repo, "scripts/ci/aggregate-evidence.py"), "--baseline-artifacts", bundle, "--repo", repo, "--sha", head, "--run-id", "71", "--attempt", "1"], { env: { ...fixture.env, GITHUB_STEP_SUMMARY: summaryPath }, encoding: "utf8" });
    assert.ok(run.stdout, run.stderr);
    const result = JSON.parse(run.stdout);
    assert.equal(run.status, result.ok ? 0 : 1, "terminal exit still agrees with aggregate verdict");
    const summary = readFileSync(summaryPath, "utf8");
    assert.ok(summary.includes(`**${result.reasonCode}**`));
    assert.ok(summary.includes(`coverage: **${result.coverage}**`));
    return { ...result, stepSummary: summary };
  };
  const zipRows = async () => {
    const result = JSON.parse(execFileSync("python3", ["-B", "-c", 'import pathlib,zipfile,io,base64,json,sys\nr=[]\nfor n,d in enumerate(sorted(pathlib.Path(sys.argv[1]).iterdir()),1):\n b=io.BytesIO()\n with zipfile.ZipFile(b,"w") as z:\n  for p in d.rglob("*"):\n   if p.is_file(): z.write(p,p.relative_to(d))\n r.append(dict(id=n,name=d.name,expired=False,bytes=base64.b64encode(b.getvalue()).decode()))\nprint(json.dumps(r))', bundle], { encoding: "utf8" }));
    return result;
  };
  return { ...fixture, bundle, plan, core, aggregate, zipRows, fs, join };
}

for (const coverage of ["full", "selective"]) {
  test(`actual ${coverage} Core evidence completes aggregate and ZIP baseline collection`, async (t) => {
    onlineContext(t);
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    const fixture = await localBundle(t, coverage);
    const { fs, join, core, plan } = fixture;
    const coreDirectory = join(fixture.bundle, `p1-core-evidence-${fixture.head}-1`);
    const metaPath = join(coreDirectory, "p1-core.meta.json");
    let mutation = null, artifacts = await fixture.zipRows();
    globalThis.fetch = async (url) => {
      if (mutation === "permission") return { ok: false, status: 403 };
      const run = { id: 71, run_attempt: 1, head_sha: fixture.head, path: ".github/workflows/ci.yml", conclusion: "success", event: mutation === "H1" ? "workflow_dispatch" : "push" };
      if (mutation === "wrong-head") run.head_sha = "c".repeat(40);
      if (mutation === "wrong-attempt") run.run_attempt = 2;
      if (mutation === "wrong-run") run.id = 72;
      if (mutation === "wrong-workflow") run.path = "other.yml";
      if (mutation?.startsWith("run-")) run.conclusion = mutation.slice(4);
      const names = ["plan", "verify", ...Object.keys(fixture.plan.shards).map((shard) => `p1 (p1-${shard})`)];
      let value;
      if (url.endsWith("/zip")) {
        const id = Number(url.match(/artifacts\/(\d+)/u)[1]);
        const row = artifacts.find((item) => item.id === id);
        const bytes = Buffer.from(row.bytes, "base64");
        return { ok: true, arrayBuffer: async () => bytes };
      }
      if (url.includes("/jobs?")) {
        const jobs = names.map((name) => ({ name, conclusion: "success" }));
        if (["failure", "cancelled", "timed_out", "skipped"].includes(mutation)) jobs.at(-1).conclusion = mutation;
        if (mutation === "missing-job") jobs.pop();
        if (mutation === "partial-job") jobs.at(-1).conclusion = null;
        if (mutation === "verify-failure") jobs.find((job) => job.name === "verify").conclusion = "failure";
        value = { total_count: mutation === "partial-jobs" ? 101 : jobs.length, jobs };
      } else if (url.includes("/artifacts?")) {
        const rows = artifacts.map(({ bytes, ...row }) => ({ ...row, expired: mutation === "expired" }));
        if (mutation === "missing-artifact") rows.pop();
        if (mutation === "mislabeled-artifact") rows[0].name = "wrong";
        value = { total_count: mutation === "partial-artifacts" ? 101 : rows.length, artifacts: rows };
      } else value = /\/actions\/runs\/\d+$/u.test(url) ? run : { workflow_runs: [run] };
      return { ok: true, json: async () => value };
    };
    const input = { complete: true, repository: "example/project", comparison: { base: fixture.head } };
    const collect = (pinnedRun) => withFixtureEnvironment({ TMPDIR: fixture.directory }, () => collectBaseline(input, fixture.repo, pinnedRun));

    // Independent subtests keep a runner assertion from hiding the collector's
    // own positive and negative verdicts. All use the same real retained Core.
    await t.test("actual task argv, progress, raw receipts and source before/after", async () => {
      assert.equal(core.capture.exitCode, 0, JSON.stringify(core.shard));
      assert.equal(core.shard.ok, true);
      assert.equal(core.task.reasonCode, coverage === "full" ? "TESTS_VERIFIED" : "TESTS_SELECTED_VERIFIED");
      assert.deepEqual(core.step.command, ["node", "scripts/task.mjs", "test", "--ci-plan", core.planPath]);
      assert.deepEqual(core.task.tests, fixture.plan.coreTests);
      assert.deepEqual(core.task.argv, ["--test", ...fixture.plan.coreTests]);
      assert.equal(core.task.progress.status, "completed");
      assert.deepEqual(core.capture.errors, []);
      assert.deepEqual(core.capture.retainedTestControllerOutput.errors, []);
      assert.deepEqual(core.input, core.output);
      assert.deepEqual(core.inputManifest, core.outputManifest);
      assert.deepEqual(core.inputManifest.coreTestFiles, fixture.plan.sourceCoreTests);
      assert.match(await fs.readFile(join(coreDirectory, "p1-core-controller.stdout"), "utf8"), /component a/u);
      assert.equal(await fs.readFile(join(coreDirectory, "p1-core-controller.stderr"), "utf8"), "");
      const markers = (await fs.readFile(fixture.env.CI_COMPONENT_OBSERVED, "utf8")).trim().split("\n").sort();
      assert.deepEqual(markers, coverage === "full" ? ["a", "b"] : ["a"]);
      assert.deepEqual(await fs.readdir(core.temporary), []);
      await assert.rejects(fs.lstat(join(fixture.repo, ".git/einzbern-output.lock")), { code: "ENOENT" });
      assert.equal(fixture.git("status", "--porcelain=v1", "--untracked-files=all"), "");
    });
    await t.test("genuine aggregate succeeds with honest coverage", () => {
      const result = fixture.aggregate();
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.reasonCode, coverage === "full" ? "CI_VERIFIED" : "CI_SELECTED_VERIFIED");
      assert.equal(result.coverage, coverage);
      assert.ok(result.stepSummary.includes(`Core files: ${plan.coreTests.length} / ${plan.sourceCoreTests.length}`));
      assert.ok(result.stepSummary.includes(`Portal files: ${plan.portalTests.length} / ${plan.sourcePortalTests.length}`));
      assert.match(result.stepSummary, /Execution seconds \| Observed tests/u);
      assert.match(result.stepSummary, /\| core \| [0-9.]+ \| [12] \| [12] \|/u);
      assert.match(result.stepSummary, /\| checks \| unknown \| unknown \| n\/a/u);
      if (coverage === "selective") {
        assert.match(result.stepSummary, /portal: no-portal-impact/u);
        assert.match(result.stepSummary, /tests\/b.test.mjs: audited-category-union/u);
      } else assert.equal(result.stepSummary.includes("Not applicable"), false);
    });
    await t.test("genuine real ZIP collector succeeds", async () => {
      for (const pinned of [undefined, "71"]) {
        const admitted = await collect(pinned);
        assert.equal(admitted.state, "verified", JSON.stringify(admitted));
        assert.equal(admitted.coverage, coverage);
        assert.equal(admitted.verification, coverage === "full" ? "CI_VERIFIED" : "CI_SELECTED_VERIFIED");
      }
    });

    const originalMeta = await fs.readFile(metaPath);
    const metadataCases = [
      ["run", (meta) => { meta.ciIdentity.GITHUB_RUN_ID = "999"; }, /run or attempt|run identity/u],
      ["attempt", (meta) => { meta.ciIdentity.GITHUB_RUN_ATTEMPT = "2"; }, /run or attempt|run identity/u],
      ["tree", (meta) => { meta.input.tree = "c".repeat(40); }, /identity|tree/u],
      ["head", (meta) => { meta.input.head = "c".repeat(40); }, /identity|SHA/u],
      ["source bytes", (meta) => { meta.inputManifest.files[0].sha256 = "c".repeat(64); meta.outputManifest = meta.inputManifest; }, /source|JSON/u],
      ["missing plan receipt", (meta) => { delete meta.artifactFiles["impact-plan.json"]; }, /impact-plan|plan/u],
      ["plan digest", (meta) => { meta.planDigest = "c".repeat(64); }, /digest|plan/u],
      ["coverage relabel", (meta) => { meta.coverage = coverage === "full" ? "selective" : "full"; }, /coverage/u],
      ["controller receipt missing", (meta) => { delete meta.retainedTestControllerOutput.files.stdout; }, /stream|controller/u],
    ];
    for (const [name, patch, reason] of metadataCases) await t.test(`rejects ${name}`, async () => {
      try {
        const meta = JSON.parse(originalMeta); patch(meta);
        await fs.writeFile(metaPath, JSON.stringify(meta));
        const refused = fixture.aggregate();
        assert.equal(refused.ok, false, name);
        assert.match(refused.failures.join("\n"), reason);
        artifacts = await fixture.zipRows();
        assert.equal((await collect()).state, "unavailable", name);
      } finally { await fs.writeFile(metaPath, originalMeta); artifacts = await fixture.zipRows(); }
    });

    for (const [name, change, reason] of [
      ["same plan JSON with changed bytes", (bytes) => Buffer.from(JSON.stringify(JSON.parse(bytes))), /Artifact|totals|receipt/u],
      ["truncated controller bytes", (bytes) => {
        const output = bytes.toString("utf8");
        assert.deepEqual(Buffer.from(output), bytes, "real controller output must be valid UTF-8");
        const duration = /^(?:#|ℹ) duration_ms \d+(?:\.\d+)?\r?$/mu.exec(output);
        assert.ok(duration, "real controller output must contain its required final duration line");
        return Buffer.from(output.slice(0, duration.index));
      }, /^core: Controller final test summary is truncated or unsupported$/mu],
    ]) await t.test(`rejects ${name}`, async (t) => {
      const path = join(coreDirectory, name.startsWith("same") ? "impact-plan.json" : "p1-core-controller.stdout");
      const bytes = await fs.readFile(path);
      try {
        await fs.writeFile(path, change(bytes));
        await t.test("aggregate rejects the intended byte mutation", () => {
          const refused = fixture.aggregate();
          assert.equal(refused.ok, false);
          assert.match(refused.failures.join("\n"), reason);
        });
        await t.test("real ZIP collector independently rejects the byte mutation", async () => {
          artifacts = await fixture.zipRows();
          assert.equal((await collect()).state, "unavailable");
        });
      } finally { await fs.writeFile(path, bytes); artifacts = await fixture.zipRows(); }
    });

    await t.test("fully resealed selection, N/A, reason and source forgeries and invalid digests still fail independent derivation", async (t) => {
      const { digest, validatePlan } = await import("../scripts/ci/impact-plan.mjs");
      const { createTransport } = await import("../scripts/ci/transport-evidence.mjs");
      const { execFileSync } = await import("node:child_process");
      const saved = new Map();
      async function save(directory) {
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
          const path = join(directory, entry.name);
          if (entry.isDirectory()) await save(path); else saved.set(path, await fs.readFile(path));
        }
      }
      await save(fixture.bundle);
      await t.test("current source derives the genuine plan", () => {
        assert.deepEqual(validatePlan(fixture.plan, fixture.repo, fixture.env), fixture.plan);
      });
      for (const [name, patch, reason] of [
        ["selection", { coreTests: [] }, /plan|source|validate-baseline|Full coverage/u],
        ["N/A", { notApplicable: coverage === "selective" ? [] : [{ task: "core", rule: "skipped" }] }, /plan|source|validate-baseline|Full coverage/u],
        ["rules", { rulesHash: "d".repeat(64) }, /plan|source|validate-baseline|Full coverage/u],
        ["source", { sourceCoreTests: [] }, /plan|source|validate-baseline|Full coverage/u],
        ["reason-only", { reasons: [...fixture.plan.reasons, "forged-reason"].sort() }, /validate-baseline/u],
        ["invalid plan digest", { planDigest: "d".repeat(64) }, /Canonical plan digest mismatch/u],
      ]) await t.test(`rejects ${name} forgery`, async (t) => {
        try {
          const forged = { ...fixture.plan, ...patch };
          if (!Object.hasOwn(patch, "planDigest")) {
            delete forged.planDigest; forged.planDigest = digest(forged);
          }
          await t.test("current source rejects independent derivation", () => {
            assert.throws(() => validatePlan(forged, fixture.repo, fixture.env), /independently derived source\/event\/rules\/rosters/u);
          });
          execFileSync("python3", ["-B", "-c", `
import json,pathlib,sys,hashlib
root=pathlib.Path(sys.argv[1]);p=json.loads(sys.argv[2])
def write(path,value): path.write_text(json.dumps(value,indent=2)+"\\n")
def receipt(path): b=path.read_bytes();return dict(file=path.name,bytes=len(b),sha256=hashlib.sha256(b).hexdigest())
write(root/("plan-evidence-"+p["head"]+"-1")/"impact-plan.json",p)
for shard in p["shards"]:
 d=root/("p1-"+shard+"-evidence-"+p["head"]+"-1");mp=d/("p1-"+shard+".meta.json");m=json.loads(mp.read_text())
 m.update(impactPlan=p,planDigest=p["planDigest"],selectedCoreTests=p["coreTests"])
 m["finalShardReceipt"]["planDigest"]=p["planDigest"]
 write(d/"impact-plan.json",p);m["artifactFiles"]["impact-plan.json"]=receipt(d/"impact-plan.json")
 write(d/"shard.json",m["finalShardReceipt"]);write(d/("p1-"+shard+".stdout"),m["finalShardReceipt"])
 m["stdout"]=receipt(d/("p1-"+shard+".stdout"))
 if shard=="core":
  path=d/"steps/leg-test.stdout";value=json.loads(path.read_text());value.update(planDigest=p["planDigest"],tests=p["coreTests"],argv=["--test"]+p["coreTests"]);write(path,value)
 for name in m["extraArtifacts"]: m["extraArtifacts"][name]={**receipt(d/name),"file":name}
 write(mp,m)
seal=root/("package-smoke-"+p["head"]+"-1")/"package-seal.json";value=json.loads(seal.read_text());value["identity"]["planDigest"]=p["planDigest"];write(seal,value)
`, fixture.bundle, JSON.stringify(forged)]);
          const transport = join(fixture.bundle, `plan-evidence-${fixture.head}-1`, "transport");
          await fs.rm(transport, { recursive: true });
          await createTransport(transport, forged);
          await t.test("aggregate rejects the forged plan and resealed evidence", () => {
            const refused = fixture.aggregate();
            assert.equal(refused.ok, false, "fully resealed plan must fail independent Git/event/rules derivation");
            assert.match(refused.failures.join("\n"), reason);
          });
          await t.test("real ZIP collector independently rejects the resealed forgery", async () => {
            artifacts = await fixture.zipRows();
            assert.equal((await collect()).state, "unavailable");
          });
        } finally {
          for (const [path, bytes] of saved) await fs.writeFile(path, bytes);
          artifacts = await fixture.zipRows();
        }
      });
    });

    for (const name of ["permission", "H1", "run-failure", "run-cancelled", "run-timed_out", "run-skipped", "failure", "cancelled", "timed_out", "skipped", "verify-failure", "missing-job", "partial-job", "partial-jobs", "partial-artifacts", "expired", "missing-artifact", "mislabeled-artifact", "wrong-head", "wrong-attempt", "wrong-run", "wrong-workflow"]) {
      await t.test(`collector rejects ${name}`, async () => {
        mutation = name;
        try { assert.equal((await collect()).state, "unavailable", name); }
        finally { mutation = null; }
      });
    }
    await t.test("restoring genuine evidence restores both positive verdicts", async () => {
      assert.equal(fixture.aggregate().ok, true);
      assert.equal((await collect()).state, "verified");
      assert.deepEqual((await fs.readdir(fixture.directory)).filter((name) => name.startsWith("einzbern-ci-baseline-")), []);
    });
  });
}

for (const nativeIpcMutation of [
  { replace: ["const socket = createConnection(socketPath);", 'const socket = createConnection(443, "example.invalid");'] },
  { replace: ["await requirePrivateDirectory(socketPath);", "// private validation removed"] },
  { append: 'createConnection("relative.sock");' },
  { replace: ["await requirePrivateDirectory(socketPath);\n  const stat = await lstat(socketPath);", "const stat = await lstat(socketPath);"], rebindDigest: true },
  { replace: ["await requirePrivateDirectory(socketPath);\n  if (controller?.capability", "if (controller?.capability"], rebindDigest: true },
  { replace: ["const socket = createConnection(socketPath);", 'const socket = createConnection(443, "example.invalid");'], rebindDigest: true },
  { append: 'createConnection("relative.sock");', rebindDigest: true },
  { append: "const alias = createConnection;", rebindDigest: true },
]) {
  test("native Unix source classification rejects changed call/validation sites", async t => {
    const fixture = await createOfflineScannerFixture(t, { nativeIpcMutation });
    const run = runFixtureTask(fixture, ["offline"]);
    assert.equal(run.status, 1, run.stdout || run.stderr);
    const report = JSON.parse(run.stderr.trim().split("\n").at(-1));
    assert.equal(report.reasonCode, "OFFLINE_BOUNDARY_FINDINGS");
    assert.ok(report.error.includes("NETWORK_MODULE:scripts/lib/codex-native-hook-ipc.mjs"));
  });
}
