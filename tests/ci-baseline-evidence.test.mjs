// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import { verifyBaseline, collectBaseline } from "../scripts/ci/baseline-evidence.mjs";
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

// Real aggregate component fixtures: only network transport is mocked. Every
// artifact is a real ZIP; raw streams, receipts, Git bytes and plan are reread.
async function localBundle(t, coverage) {
  const fs = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join, dirname, resolve } = await import("node:path");
  const { execFileSync, spawnSync } = await import("node:child_process");
  const { createPlan, sourceInput, digest, documentReaderClosure } = await import("../scripts/ci/impact-plan.mjs");
  const { createTransport } = await import("../scripts/ci/transport-evidence.mjs");
  const directory = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "einzbern-baseline-component-")));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const repo = join(directory, "repo"), bundle = join(directory, "artifacts");
  await fs.mkdir(repo); await fs.mkdir(bundle);
  const source = resolve(import.meta.dirname, "..");
  const copied = new Set();
  async function copy(path) {
    if (copied.has(path)) return;
    copied.add(path);
    const text = await fs.readFile(join(source, path), "utf8");
    await fs.mkdir(dirname(join(repo, path)), { recursive: true });
    await fs.writeFile(join(repo, path), text);
    for (const match of text.matchAll(/(?:from\s*|import\s*)["'](\.[^"']+)["']/gu)) {
      const dependency = resolve(dirname(join(source, path)), match[1]);
      await copy(dependency.slice(source.length + 1));
    }
  }
  for (const path of ["scripts/ci/impact-plan.mjs", "scripts/ci/transport-evidence.mjs", "scripts/ci/aggregate-evidence.py", "scripts/ci/p1-evidence.py"]) await copy(path);
  // Python imports its sibling dynamically, already copied above.
  for (const path of ["tests", "portal/tests"]) await fs.mkdir(join(repo, path), { recursive: true });
  for (const path of ["tests/a.test.mjs", "tests/b.test.mjs", "portal/tests/a.test.mjs"]) await fs.writeFile(join(repo, path), 'import test from "node:test"; test("harmless", () => {});\n');
  const rules = { version: 1, docs: { "README.md": ["tests/a.test.mjs"] }, ciTests: ["tests/a.test.mjs"], privacyPaths: [], privacyTests: [], portalPaths: [], portalTests: [], consumers: { privacy: [], portal: [] }, documentConsumers: { "README.md": "README.md" }, documentAudit: { readers: [], tests: ["tests/a.test.mjs"] } };
  const auditTexts = new Map(await Promise.all([...copied].filter((path) => /\.(?:mjs|js|ts)$/u.test(path)).map(async (path) => [path, await fs.readFile(join(repo, path), "utf8")])));
  rules.documentAudit.readers = documentReaderClosure(auditTexts, Object.keys(rules.docs));
  await fs.writeFile(join(repo, "scripts/ci/impact-rules.json"), JSON.stringify(rules));
  await fs.writeFile(join(repo, "README.md"), "old\n");
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  git("init", "--quiet");
  const commit = () => { git("add", "."); git("-c", "user.name=Fixture", "-c", "user.email=fixture-identity", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "component"); };
  commit(); const before = git("rev-parse", "HEAD");
  await fs.writeFile(join(repo, "README.md"), "new\n"); commit();
  const head = git("rev-parse", "HEAD");
  const env = { GITHUB_EVENT_NAME: "push", GITHUB_REPOSITORY: "example/project", GITHUB_RUN_ID: "71", GITHUB_RUN_ATTEMPT: "1" };
  const input = sourceInput(repo, env, { before, after: head });
  if (coverage === "selective") input.baseline = { ...full, sha: before };
  const plan = createPlan(input, rules, digest(JSON.stringify(rules)));
  assert.equal(plan.coverage, coverage);
  const planDir = join(bundle, `plan-evidence-${head}-1`);
  await fs.mkdir(planDir);
  await fs.writeFile(join(planDir, "impact-plan.json"), JSON.stringify(plan, null, 2) + "\n");
  await createTransport(join(planDir, "transport"), plan);
  const program = `
import importlib.util,json,pathlib,sys,hashlib
root=pathlib.Path(sys.argv[1]); repo=pathlib.Path(sys.argv[2]); plan=json.loads(sys.argv[3])
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
 mode="p1-"+shard; d=root/(mode+"-evidence-"+plan["head"]+"-1");d.mkdir()
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
   if task=="test":
    command+=["--ci-plan","fixture-plan.json"]
    output=json.dumps(dict(ok=True,reasonCode="TESTS_VERIFIED" if plan["coverage"]=="full" else "TESTS_SELECTED_VERIFIED",tests=plan["coreTests"],argv=["--test"]+plan["coreTests"],planDigest=plan["planDigest"],coverage=plan["coverage"]))+"\\n"
   for suffix,value in [(".json",dict(command=command,exitCode=0,signal=None)),(".stdout",output),(".stderr","")]:
    write(d/(name+suffix),value);seal(d,meta,name+suffix)
 if shard=="core":
  meta["retainedTestControllerOutput"]={"errors":[],"files":{}}
  for kind in ["stdout","stderr"]:
   name=mode+"-controller."+kind;write(d/name,totals if kind=="stdout" else "")
   meta["retainedTestControllerOutput"]["files"][kind]=m.file_receipt(d/name)
  meta["testTotals"]=m.parse_test_totals(totals.encode())
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
  execFileSync("python3", ["-B", "-c", program, bundle, repo, JSON.stringify(plan)]);
  const aggregate = () => {
    const run = spawnSync("python3", ["-B", join(repo, "scripts/ci/aggregate-evidence.py"), "--baseline-artifacts", bundle, "--repo", repo, "--sha", head, "--run-id", "71", "--attempt", "1"], { encoding: "utf8" });
    assert.ok(run.stdout, run.stderr);
    return JSON.parse(run.stdout);
  };
  const zipRows = async () => {
    const result = JSON.parse(execFileSync("python3", ["-B", "-c", 'import pathlib,zipfile,io,base64,json,sys\nr=[]\nfor n,d in enumerate(sorted(pathlib.Path(sys.argv[1]).iterdir()),1):\n b=io.BytesIO()\n with zipfile.ZipFile(b,"w") as z:\n  for p in d.rglob("*"):\n   if p.is_file(): z.write(p,p.relative_to(d))\n r.append(dict(id=n,name=d.name,expired=False,bytes=base64.b64encode(b.getvalue()).decode()))\nprint(json.dumps(r))', bundle], { encoding: "utf8" }));
    return result;
  };
  return { directory, repo, bundle, plan, head, aggregate, zipRows, fs, join };
}

test("actual full/selective aggregate and ZIP baseline collector admit sound coverage and reject provenance failures", async (t) => {
  onlineContext(t);
  const originalTmpdir = process.env.TMPDIR;
  t.after(() => { if (originalTmpdir === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = originalTmpdir; });
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  for (const coverage of ["full", "selective"]) {
    const fixture = await localBundle(t, coverage);
    // Keep collector temp artifacts inside this owned, canonical test root.
    process.env.TMPDIR = fixture.directory;
    const result = fixture.aggregate();
    assert.equal(result.ok, true);
    assert.equal(result.reasonCode, coverage === "full" ? "CI_VERIFIED" : "CI_SELECTED_VERIFIED");
    if (coverage === "selective") {
      const { assertP8TagPreconditions } = await import("../scripts/lib/release-tag-gate.mjs");
      assert.throws(() => assertP8TagPreconditions({ p8Result: result, expectedTag: "v0.0.0", tagCommit: fixture.head, p8BasisCommit: fixture.head }));
    }
    // Execute the real shard runner and detached controller on this tiny roster.
    // Other P1 legs remain artifact validator component inputs, never a recursive suite.
    {
      const { runShard } = await import("../scripts/ci/p1-shard.mjs");
      const { fs, join } = fixture;
      const planPath = join(fixture.directory, "execution-plan.json");
      const eventPath = join(fixture.repo, ".git", "event.json");
      const evidence = join(fixture.directory, "execution-evidence");
      await fs.mkdir(evidence);
      await fs.writeFile(planPath, JSON.stringify(fixture.plan));
      await fs.writeFile(eventPath, JSON.stringify({ before: fixture.plan.comparison.before, after: fixture.head }));
      await fs.writeFile(join(fixture.repo, "scripts/task.mjs"), `
import { readFile } from "node:fs/promises";
import { runDetachedTestController } from ${JSON.stringify(new URL("../scripts/task.mjs", import.meta.url).href)};
import { withExclusiveOutputSession } from ${JSON.stringify(new URL("../scripts/lib/safe-io.mjs", import.meta.url).href)};
const plan=JSON.parse(await readFile(process.argv[4],"utf8"));
const result=await withExclusiveOutputSession(process.cwd(), async()=>runDetachedTestController(["--test",...plan.coreTests], { NODE_OPTIONS: ${JSON.stringify("--import=" + new URL("../scripts/no-network.mjs", import.meta.url).href)}, EINZBERN_HOME: ${JSON.stringify(join(fixture.directory, "device"))} }, plan.coreTests, false, process.cwd()));
process.stdout.write(JSON.stringify({ok:true,reasonCode:plan.coverage==="full"?"TESTS_VERIFIED":"TESTS_SELECTED_VERIFIED",tests:plan.coreTests,argv:["--test",...plan.coreTests],coverage:plan.coverage,planDigest:plan.planDigest,progress:result.progress})+"\\n");
`);
      const overrides = { GITHUB_EVENT_PATH: eventPath, GITHUB_RUN_ID: "71", GITHUB_RUN_ATTEMPT: "1", EINZBERN_CI_EVIDENCE_DIR: evidence };
      const saved = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
      Object.assign(process.env, overrides);
      try {
        const executed = await runShard("core", fixture.repo, planPath);
        assert.equal(executed.ok, true);
        assert.equal(executed.coverage, coverage);
        const step = JSON.parse(await fs.readFile(join(evidence, "steps/leg-test.json"), "utf8"));
        assert.deepEqual(step.command, ["node", "scripts/task.mjs", "test", "--ci-plan", planPath]);
        const observed = JSON.parse((await fs.readFile(join(evidence, "steps/leg-test.stdout"), "utf8")).trim());
        assert.deepEqual(observed.tests, fixture.plan.coreTests);
        assert.deepEqual(observed.argv, ["--test", ...fixture.plan.coreTests]);
        assert.equal(observed.progress.status, "completed");
      } finally {
        for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      }
    }
    const { fs, join } = fixture;
    const coreDirectory = join(fixture.bundle, `p1-core-evidence-${fixture.head}-1`);
    const metaPath = join(coreDirectory, "p1-core.meta.json");
    const originalMeta = await fs.readFile(metaPath);
    for (const patch of [
      (meta) => { meta.ciIdentity.GITHUB_RUN_ID = "999"; },
      (meta) => { meta.input.tree = "c".repeat(40); },
      (meta) => { meta.input.head = "c".repeat(40); },
      (meta) => { meta.inputManifest.files[0].sha256 = "c".repeat(64); meta.outputManifest = meta.inputManifest; },
      (meta) => { delete meta.artifactFiles["impact-plan.json"]; },
    ]) {
      const meta = JSON.parse(originalMeta);
      patch(meta);
      await fs.writeFile(metaPath, JSON.stringify(meta));
      assert.equal(fixture.aggregate().ok, false);
      await fs.writeFile(metaPath, originalMeta);
    }
    const planPath = join(coreDirectory, "impact-plan.json");
    const originalBytes = await fs.readFile(planPath);
    await fs.writeFile(planPath, JSON.stringify(JSON.parse(originalBytes)));
    assert.equal(fixture.aggregate().ok, false, "same JSON with changed retained bytes must fail");
    await fs.writeFile(planPath, originalBytes);
    if (coverage === "selective") {
      const { digest } = await import("../scripts/ci/impact-plan.mjs");
      const { createTransport } = await import("../scripts/ci/transport-evidence.mjs");
      const { execFileSync } = await import("node:child_process");
      const saved = new Map();
      async function save(directory) { for (const entry of await fs.readdir(directory, { withFileTypes: true })) { const path = join(directory, entry.name); if (entry.isDirectory()) await save(path); else saved.set(path, await fs.readFile(path)); } }
      await save(fixture.bundle);
      for (const patch of [{ coreTests: [] }, { notApplicable: [] }]) {
        const forged = { ...fixture.plan, ...patch };
        delete forged.planDigest; forged.planDigest = digest(forged);
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
        const refused = fixture.aggregate();
        assert.equal(refused.ok, false, "fully resealed forged selection/N-A must fail independent derivation");
        for (const [path, bytes] of saved) await fs.writeFile(path, bytes);
      }
    }
    assert.equal(fixture.aggregate().ok, true, "restored genuine evidence remains admissible");
    const artifacts = await fixture.zipRows();
    let mutation = null;
    globalThis.fetch = async (url) => {
      if (mutation === "permission") return { ok: false, status: 403 };
      const run = { id: 71, run_attempt: 1, head_sha: fixture.head, path: ".github/workflows/ci.yml", conclusion: "success", event: mutation === "H1" ? "workflow_dispatch" : "push" };
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
        value = { total_count: mutation === "partial-jobs" ? 101 : jobs.length, jobs };
      } else if (url.includes("/artifacts?")) {
        const rows = artifacts.map(({ bytes, ...row }) => ({ ...row, expired: mutation === "expired" }));
        if (mutation === "missing-artifact") rows.pop();
        if (mutation === "mislabeled-artifact") rows[0].name = "wrong";
        value = { total_count: mutation === "partial-artifacts" ? 101 : rows.length, artifacts: rows };
      } else value = { workflow_runs: [run] };
      return { ok: true, json: async () => value };
    };
    const input = { complete: true, repository: "example/project", comparison: { base: fixture.head } };
    const admitted = await collectBaseline(input, fixture.repo);
    assert.equal(admitted.state, "verified", JSON.stringify(admitted));
    assert.equal(admitted.coverage, coverage);
    for (mutation of ["permission", "H1", "failure", "cancelled", "timed_out", "skipped", "missing-job", "partial-jobs", "partial-artifacts", "expired", "missing-artifact", "mislabeled-artifact"]) {
      const refused = await collectBaseline(input, fixture.repo);
      assert.equal(refused.state, "unavailable", mutation + JSON.stringify(refused));
    }
  }
});
