// SPDX-License-Identifier: Apache-2.0
import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { acquireMemoryBudget, checkMemorySample, MEMORY_LEASE_VARIABLE, MEMORY_POLICY_SETTING, MiB, memoryPhase, memoryTestArguments, parseMemoryPolicy, planMemory, processTable, readMemoryPolicy } from "../scripts/lib/memory-budget.mjs";

const snapshot = () => ({ sampledAt: Date.now(), limitBytes: 16 * 1024 * MiB, availableBytes: 12 * 1024 * MiB, stallPercent: 0, pressureSource: "linux-psi-full-avg10" });
const policy = (overrides = {}) => parseMemoryPolicy(JSON.stringify({ enabled: true, reserveMiB: 1024, budgetMiB: 1024, fixedMiB: 128, workerMiB: 256, maxWorkers: 8, ...overrides }));
async function fixture(t, value = policy()) {
  const home = await mkdtemp(join(tmpdir(), "memory-budget-test-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, "machine-settings.json"), JSON.stringify({ schemaVersion: "tcrn.machine-settings.v1", values: { [MEMORY_POLICY_SETTING]: JSON.stringify(value) } }));
  return { deviceHome: home, directory: join(home, "locks"), command: "test", env: {}, sample: snapshot };
}
const code = reason => error => error.reasonCode === reason;

test("closed policy rejects unknown, nonfinite and overflowing budgets", () => {
  assert.equal(policy().maxWorkers, 8);
  for (const bad of [{ enabled: true, extra: 1 }, { enabled: true, maxWorkers: 0 }, { enabled: true, budgetMiB: Number.MAX_SAFE_INTEGER }, { enabled: true, workerMiB: "512" }, { enabled: true, maxUsedPercent: 101 }]) assert.throws(() => parseMemoryPolicy(JSON.stringify(bad)), code("MEMORY_POLICY_INVALID"));
});
test("capacity, headroom, fixed overhead and hard worker cap all constrain admission", () => {
  assert.equal(planMemory(policy(), snapshot()).workers, 3);
  assert.equal(planMemory(policy(), { ...snapshot(), cpuParallelism: 1 }).workers, 1);
  assert.equal(planMemory(policy({ maxWorkers: 2 }), snapshot()).workers, 2);
  const scarce = { ...snapshot(), availableBytes: 1200 * MiB };
  assert.equal(planMemory(policy({ maxUsedPercent: 100 }), scarce).workers, 0);
  assert.equal(planMemory(policy({ maxUsedPercent: 100 }), { ...snapshot(), limitBytes: 1100 * MiB, availableBytes: 1100 * MiB }).workers, 0);
});
test("already resident bytes are credited once; unknown observation receives no credit", () => {
  const p = policy({ budgetMiB: 8192, fixedMiB: 128, maxUsedPercent: 100 });
  const s = { ...snapshot(), availableBytes: 2048 * MiB };
  assert.equal(planMemory(p, s, [{ bytes: 1024 * MiB, residentBytes: 1024 * MiB }]).workers, 3);
  assert.equal(planMemory(p, s, [{ bytes: 1024 * MiB, residentBytes: null }]).workers, 0);
});
test("stale, future, unknown and pressured samples never grant a slot", () => {
  const p = policy(); const now = Date.now();
  assert.throws(() => checkMemorySample({ ...snapshot(), sampledAt: now - 3000 }, p, now), code("MEMORY_SAMPLE_INVALID_OR_STALE"));
  assert.throws(() => checkMemorySample({ ...snapshot(), sampledAt: now + 1 }, p, now), code("MEMORY_SAMPLE_INVALID_OR_STALE"));
  assert.throws(() => checkMemorySample({ ...snapshot(), pressureSource: null }, p), code("MEMORY_SAMPLE_INVALID_OR_STALE"));
  assert.throws(() => checkMemorySample({ ...snapshot(), stallPercent: 2 }, p), code("MEMORY_PRESSURE_HIGH"));
});
test("unset policy preserves legacy path; malformed settings refuse", async t => {
  const options = await fixture(t);
  await rm(join(options.deviceHome, "machine-settings.json"));
  assert.equal(readMemoryPolicy(options.deviceHome), null);
  assert.equal(await acquireMemoryBudget(options), null);
  await writeFile(join(options.deviceHome, "machine-settings.json"), "broken");
  await assert.rejects(acquireMemoryBudget(options), code("MEMORY_POLICY_UNREADABLE"));
});
test("root reservation, budget refusal, explicit release and bounded evidence", async t => {
  const options = await fixture(t);
  const lease = await acquireMemoryBudget(options);
  assert.equal(lease.workers, 3);
  assert.equal(memoryPhase(options.env, snapshot).workers, 3);
  await assert.rejects(acquireMemoryBudget({ ...options, env: {} }), code("MEMORY_BUDGET_INSUFFICIENT"));
  lease.release();
  assert.equal(options.env[MEMORY_LEASE_VARIABLE], undefined);
  const receipt = JSON.parse(await readFile(join(options.directory, "memory-receipts", `${lease.token}.json`), "utf8"));
  assert.equal(receipt.status, "released"); assert.equal(receipt.workers, 3);
  assert.equal(receipt.peakKind, "sampled-process-tree-rss-not-exact-peak");
  assert.equal(JSON.parse(await readFile(join(options.directory, "memory-budget.json"), "utf8")).leases.length, 0);
});
test("nested reservations subdivide and serialize, never mint extra budget", async t => {
  const options = await fixture(t, policy({ budgetMiB: 4096 }));
  const root = await acquireMemoryBudget(options);
  const childEnv = { ...options.env };
  const child = await acquireMemoryBudget({ ...options, env: childEnv, command: "nested-test" });
  assert.ok(child.bytes <= root.bytes - 128 * MiB);
  await assert.rejects(acquireMemoryBudget({ ...options, env: { ...options.env } }), code("MEMORY_BUDGET_BUSY"));
  assert.throws(() => memoryPhase(options.env, snapshot), code("MEMORY_CHILD_BUDGET_ACTIVE"));
  assert.throws(() => root.release(), code("MEMORY_RELEASE_UNCONFIRMED"));
  child.release(); root.release();
});
test("unknown process observation and PID reuse retain reservations", async t => {
  const options = await fixture(t);
  const original = processTable(); assert.ok(original);
  let table = original;
  const lease = await acquireMemoryBudget({ ...options, processes: () => table });
  table = null;
  assert.throws(() => lease.release(), code("MEMORY_RELEASE_UNCONFIRMED"));
  table = original.map(row => row.pid === process.pid ? { ...row, started: "different process" } : row);
  assert.throws(() => lease.release(), code("MEMORY_RELEASE_UNCONFIRMED"));
  table = original; lease.release();
});
test("old mutex and unknown owners cannot be cleared by age", async t => {
  const options = await fixture(t); await mkdir(options.directory);
  await writeFile(join(options.directory, "memory-budget.lock"), JSON.stringify({ pid: 99999999, createdAt: "2000-01-01T00:00:00Z" }));
  await assert.rejects(acquireMemoryBudget(options), code("MEMORY_BUDGET_BUSY"));
  assert.ok(await readFile(join(options.directory, "memory-budget.lock")));
});
test("independent real processes cannot both reserve one domain's remaining capacity", async t => {
  const options = await fixture(t);
  const moduleUrl = new URL("../scripts/lib/memory-budget.mjs", import.meta.url).href;
  const script = `import {acquireMemoryBudget} from ${JSON.stringify(moduleUrl)}; const o=JSON.parse(process.argv[1]);try {const l=await acquireMemoryBudget({...o,env:{},sample:()=>(${JSON.stringify(snapshot()) .replace(/"sampledAt":\d+/, '"sampledAt":Date.now()')})}); console.log('admitted');process.stdin.resume();process.stdin.on('end',()=>{l.release();process.exit(0)});}catch(e){console.log(e.reasonCode);process.exit(2)}`;
  const run = () => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, JSON.stringify({ deviceHome: options.deviceHome, directory: options.directory, command: "race" })], { stdio: ["pipe", "pipe", "pipe"] });
    const line = new Promise(resolve => child.stdout.once("data", data => resolve(String(data).trim())));
    const done = new Promise(resolve => child.once("close", resolve)); return { child, line, done };
  };
  const a = run(), b = run(); t.after(() => { a.child.stdin.end(); b.child.stdin.end(); });
  const lines = await Promise.all([a.line, b.line]);
  assert.equal(lines.filter(x => x === "admitted").length, 1);
  assert.ok(lines.some(x => ["MEMORY_BUDGET_BUSY", "MEMORY_BUDGET_INSUFFICIENT"].includes(x)));
  a.child.stdin.end(); b.child.stdin.end(); await Promise.all([a.done, b.done]);
});
test("unconfigured test argument adapter does not alter test selection", () => {
  const args = ["--test", "a.test.mjs", "b.test.mjs"];
  assert.equal(memoryTestArguments(args, {}), args);
});

test("instrumented Node runner honors actual worker limit with explicit synthetic platform telemetry", async t => {
  const options = await fixture(t, policy({ budgetMiB: 4096, maxWorkers: 2 }));
  const mock = join(options.deviceHome, "platform-fixture.mjs");
  // Only this isolated child replaces the unavailable host PSI metric; no OS files are changed.
  await writeFile(mock, `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module'; const original=fs.readFileSync; fs.readFileSync=function(p,...a){if(p==='/proc/pressure/memory')return 'full avg10=0.00 avg60=0.00 avg300=0.00 total=0\\n';return original.call(this,p,...a)}; process.availableMemory=()=>12*1024*1024*1024; process.constrainedMemory=()=>16*1024*1024*1024;syncBuiltinESMExports();`);
  const active = join(options.deviceHome, "active"); await mkdir(active);
  const files = [];
  for (let i = 0; i < 4; i++) {
    const file = join(options.deviceHome, `case-${i}.test.mjs`); files.push(file);
    await writeFile(file, `import test from 'node:test';import assert from 'node:assert/strict';import {writeFile,readdir,unlink} from 'node:fs/promises';import {join} from 'node:path';test('bounded',async()=>{const p=join(${JSON.stringify(active)},String(process.pid));await writeFile(p,'active');assert.ok((await readdir(${JSON.stringify(active)})).length<=2);await new Promise(r=>setTimeout(r,100));await unlink(p)});`);
  }
  const module = new URL("../scripts/lib/memory-budget.mjs", import.meta.url).href;
  const script = `import {acquireMemoryBudget,memoryTestArguments} from ${JSON.stringify(module)};import {spawnSync} from 'node:child_process';const lease=await acquireMemoryBudget(${JSON.stringify({ deviceHome: options.deviceHome, directory: options.directory, command: "test" })});const args=memoryTestArguments(${JSON.stringify(["--test", `--import=${mock}`, ...files])});console.log(JSON.stringify({workers:lease.workers,args}));const child=spawnSync(process.execPath,args,{env:process.env,encoding:'utf8'});process.stdout.write(child.stdout);process.stderr.write(child.stderr);lease.release();process.exitCode=child.status;`;
  const child = spawnSync(process.execPath, ["--import", mock, "--input-type=module", "-e", script], { encoding: "utf8", timeout: 20_000, env: { ...process.env, [MEMORY_LEASE_VARIABLE]: undefined } });
  assert.equal(child.status, 0, child.stderr + child.stdout);
  const decision = JSON.parse(child.stdout.split("\n")[0]); assert.equal(decision.workers, 2); assert.ok(decision.args.includes("--test-concurrency=2"));
  assert.deepEqual(await readFile(join(options.directory, "memory-budget.json"), "utf8").then(JSON.parse).then(x=>x.leases), []);
});

test("per-command baselines are applied without permitting conflicting domain ceilings", async t => {
  const options = await fixture(t, policy({ profiles: { test: { maxWorkers: 1 } } }));
  const root = await acquireMemoryBudget(options); assert.equal(root.workers, 1);
  await writeFile(join(options.deviceHome, "machine-settings.json"), JSON.stringify({ schemaVersion: "tcrn.machine-settings.v1", values: { [MEMORY_POLICY_SETTING]: JSON.stringify(policy({ budgetMiB: 8192 })) } }));
  await assert.rejects(acquireMemoryBudget({ ...options, env: {} }), code("MEMORY_DOMAIN_POLICY_CONFLICT"));
  root.release();
});
test("a leaf controller cannot mint a second heavy workload and pressure blocks new phases", async t => {
  const options = await fixture(t, policy({ budgetMiB: 4096 }));
  const root = await acquireMemoryBudget({ ...options, command: "node:test-controller" });
  await assert.rejects(acquireMemoryBudget({ ...options, env: { ...options.env } }), code("MEMORY_NESTED_WORKER_UNSUPPORTED"));
  assert.throws(() => memoryPhase(options.env, () => ({ ...snapshot(), stallPercent: 50 })), code("MEMORY_PRESSURE_HIGH"));
  assert.throws(() => memoryPhase(options.env, () => ({ ...snapshot(), limitBytes: 2048 * MiB, availableBytes: 1600 * MiB })), code("MEMORY_HEADROOM_DECREASED"));
  root.release();
});
test("a changed domain, malformed inheritance and unknown existing owner never become fresh capacity", async t => {
  const options = await fixture(t); const root = await acquireMemoryBudget(options);
  await assert.rejects(acquireMemoryBudget({ ...options, directory: join(options.deviceHome, "other") }), code("MEMORY_DOMAIN_MISMATCH"));
  await assert.rejects(acquireMemoryBudget({ ...options, env: { [MEMORY_LEASE_VARIABLE]: "broken" } }), code("MEMORY_LEASE_INVALID"));
  const table = processTable();
  const different = table.map(row => row.pid === process.pid ? { ...row, started: "new owner identity" } : row);
  await assert.rejects(acquireMemoryBudget({ ...options, env: {}, processes: () => different }), code("MEMORY_LEASE_OWNER_UNKNOWN"));
  root.release();
});

test("profile worker requests cannot raise the device cap and nested profiles retain their own lower cap", async t => {
  const options = await fixture(t, policy({ budgetMiB: 8192, maxWorkers: 3, profiles: { test: { maxWorkers: 8 }, child: { maxWorkers: 1 } } }));
  const root = await acquireMemoryBudget(options); assert.equal(root.workers, 3);
  const child = await acquireMemoryBudget({ ...options, command: "child", env: { ...options.env } });
  assert.equal(child.workers, 1); child.release(); root.release();
});

test("real task entry reports resource refusal rather than an internal or assertion failure", async t => {
  const options = await fixture(t, policy({ budgetMiB: 1, fixedMiB: 1, workerMiB: 1 }));
  const env = { ...process.env, EINZBERN_HOME: options.deviceHome, EINZBERN_HEAVY_LOCK_DIR: options.directory };
  delete env.EINZBERN_HEAVY_SLOT; delete env.EINZBERN_MEMORY_LEASE;
  const result = spawnSync(process.execPath, [new URL("../scripts/task.mjs", import.meta.url).pathname, "test"], { env, encoding: "utf8", timeout: 10_000 });
  assert.equal(result.status, 1, result.stderr); assert.equal(result.stdout, "");
  const receipt = JSON.parse(result.stderr.trim());
  assert.ok(["MEMORY_BUDGET_INSUFFICIENT", "MEMORY_PRESSURE_HIGH", "MEMORY_SAMPLE_UNAVAILABLE"].includes(receipt.reasonCode), result.stderr);
});

const root = fileURLToPath(new URL("..", import.meta.url));
const moduleUrl = new URL("../scripts/lib/memory-budget.mjs", import.meta.url).href;
const heavyUrl = new URL("../scripts/lib/heavy-runs.mjs", import.meta.url).href;
const storageUrl = new URL("../dist/build/packages/core/src/storage-configure.js", import.meta.url).href;
const gatesPlanUrl = new URL("../dist/build/packages/core/src/gates-plan.js", import.meta.url).href;
const gatesRunUrl = new URL("../dist/build/packages/core/src/gates-run.js", import.meta.url).href;

async function isolatedAdapterFixture(t, source) {
  const directory = await mkdtemp(join(tmpdir(), "memory-adapter-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const home = join(directory, "device"); await mkdir(home);
  const telemetry = join(directory, "telemetry.mjs");
  // Explicit synthetic capacity/pressure only; real process identities and real commands.
  await writeFile(telemetry, `import fs from 'node:fs';import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
const read=fs.readFileSync,exec=cp.execFileSync;
fs.readFileSync=function(p,...a){if(p==='/proc/pressure/memory')return 'full avg10=0.00 avg60=0.00 avg300=0.00 total=0\\n';if(typeof p==='string'&&/^\\/proc\\/\\d+\\/smaps_rollup$/u.test(p))return 'Private_Clean: 0 kB\\nPrivate_Dirty: 0 kB\\n';return read.call(this,p,...a)};
cp.execFileSync=function(p,a,...o){if(p==='/usr/bin/memory_pressure'&&a?.length===1&&a[0]==='-Q')return 'System-wide memory free percentage: 75%\\n';return exec.call(this,p,a,...o)};
process.availableMemory=()=>12*1024**3;process.constrainedMemory=()=>16*1024**3;syncBuiltinESMExports();`);
  await writeFile(join(home, "machine-settings.json"), JSON.stringify({ schemaVersion: "tcrn.machine-settings.v1", values: { "execution.memoryPolicy": JSON.stringify({ enabled: true, reserveMiB: 0, budgetMiB: 4096, fixedMiB: 128, workerMiB: 256, maxWorkers: 2 }) } }));
  const prelude = `import assert from 'node:assert/strict';import {execFileSync} from 'node:child_process';import {mkdir,readFile,writeFile,symlink,unlink,realpath,chmod,cp} from 'node:fs/promises';import {join} from 'node:path';
const root=${JSON.stringify(root)},directory=${JSON.stringify(directory)},home=${JSON.stringify(home)};
const m=await import(${JSON.stringify(moduleUrl)}),h=await import(${JSON.stringify(heavyUrl)});`;
  const env = { ...process.env, EINZBERN_HOME: home, COREPACK_ENABLE_NETWORK: "0", pnpm_config_verify_deps_before_run: "false" };
  delete env.EINZBERN_MEMORY_LEASE; delete env.EINZBERN_HEAVY_SLOT; delete env.EINZBERN_HEAVY_LOCK_DIR;
  const child = spawnSync(process.execPath, ["--import", telemetry, "--input-type=module", "-e", prelude + source], { cwd: root, env, encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(child.status, 0, child.stderr + child.stdout);
  return child.stdout;
}

test("official runtime relocation shares canonical count, memory and inherited domains", async t => {
  await isolatedAdapterFixture(t, `
const {configureStorageLocation}=await import(${JSON.stringify(storageUrl)});
const library=join(directory,'library'),runtime=join(directory,'runtime');await mkdir(library);await mkdir(join(home,'locks'));
await configureStorageLocation(home,library,runtime,'2026-10-29T18:00:00Z','minutes:000000000000000000000001#D1',true);
const env={EINZBERN_HOME:home};const slot=await h.acquireHeavySlot({command:'test',env,timeoutMs:0});
const canonical=await realpath(join(runtime,'locks'));assert.equal(slot.path,join(canonical,'heavy.lock'));assert.equal(slot.memory.directory,canonical);assert.equal(JSON.parse(env.EINZBERN_MEMORY_LEASE).directory,canonical);assert.ok(env.EINZBERN_HEAVY_SLOT.endsWith(slot.path));
const child=await h.acquireHeavySlot({command:'child',env:{...env},timeoutMs:0});assert.equal(child.inherited,true);assert.equal(child.memory.directory,canonical);child.release();slot.release();
assert.deepEqual(JSON.parse(await readFile(join(canonical,'memory-budget.json'),'utf8')).leases,[]);
await unlink(join(home,'locks'));const wrong=join(directory,'wrong');await mkdir(wrong);await symlink(wrong,join(home,'locks'),'dir');
await assert.rejects(h.acquireHeavySlot({command:'test',env:{EINZBERN_HOME:home},timeoutMs:0}),e=>e.reasonCode==='MEMORY_DOMAIN_INVALID');
`);
});

test("unregistered forwarding, explicit linked overrides and unsafe resource directories refuse", async t => {
  await isolatedAdapterFixture(t, `
const target=join(directory,'target');await mkdir(target);await symlink(target,join(home,'locks'),'dir');
await assert.rejects(h.acquireHeavySlot({command:'test',env:{EINZBERN_HOME:home},timeoutMs:0}),e=>e.reasonCode==='MEMORY_DOMAIN_INVALID');
const alias=join(directory,'alias');await symlink(target,alias,'dir');
await assert.rejects(h.acquireHeavySlot({command:'test',env:{EINZBERN_HOME:home,EINZBERN_HEAVY_LOCK_DIR:alias},timeoutMs:0}),e=>e.reasonCode==='MEMORY_DOMAIN_INVALID');
await chmod(target,0o777);await assert.rejects(m.acquireMemoryBudget({deviceHome:home,directory:target,command:'test',env:{}}),e=>e.reasonCode==='MEMORY_DOMAIN_INVALID');
`);
});

test("closed adapters admit pinned Corepack and all existing managed task scripts, not arbitrary forms", async t => {
  await isolatedAdapterFixture(t, `

const scripts=['archive','build','clean','format','format:check','lint','release:preflight','sbom','test','typecheck','verify:no-sibling-dependency','verify:offline','verify:p1','verify:p8','verify:privacy','verify:links','verify:retrieval-eval','verify:portal','portal:test','release'];
for(const script of scripts)for(const prefix of [['pnpm'],['corepack','pnpm@11.3.0']]){const command=[...prefix,'run','--silent',script];assert.ok(m.memoryPackageTask(command,root),JSON.stringify(command))}
for(const command of [['corepack','pnpm','run','build'],['corepack','pnpm@11.2.0','run','build'],['corepack','yarn@4.0.0','build'],['pnpm','--dir','other','run','build'],['pnpm','run','build','--extra'],['pnpm','exec','node','other.mjs'],['pnpm','run','portal'],['pnpm','run','run','build']])assert.equal(m.memoryPackageTask(command,root),null);
assert.equal(m.memoryPackageTask(['corepack','pnpm@11.3.0','run','build'],directory),null);

`);
});

test("actual planGates and runGates execute pinned Corepack format gate with enabled admission", async t => {
  const output = await isolatedAdapterFixture(t, `
const {planGates}=await import(${JSON.stringify(gatesPlanUrl)}),{runGates}=await import(${JSON.stringify(gatesRunUrl)});
const env={...process.env};const lease=await m.acquireMemoryBudget({deviceHome:home,directory:join(home,'locks'),command:'gates-run',env});
try {
const target=join(directory,'project');await cp(root,target,{recursive:true,filter:p=>!['.git','dist'].some(n=>p===join(root,n)||p.startsWith(join(root,n)+'/'))});execFileSync('git',['init','-q',target],{stdio:['ignore','pipe','pipe']});const plan=await planGates({projectRoot:target,release:true,gates:[{name:'engine:format',root:'.',command:['corepack','pnpm@11.3.0','run','--silent','format:check'],covers:['**'],required:true,enabled:true,releaseOnly:false}]});
const run=await runGates(plan,{libraryId:'workspace:'+ '1'.repeat(24),at:'2026-10-29T18:00:00Z',deviceHome:home,env});
const diagnostic=await readFile(join(home,'cache','workspace-'+ '1'.repeat(24),'gate-runs',run.run.gates[0].outputFile),'utf8');assert.deepEqual(run.run.reds,[],JSON.stringify(run)+diagnostic);assert.equal(run.run.gates.length,1);assert.equal(run.run.gates[0].ok,true,JSON.stringify(run));assert.equal(run.run.gates[0].exitCode,0);console.log(JSON.stringify(run));
} finally {lease.release()}
`);
  assert.ok(output.includes("engine:format"));
});
