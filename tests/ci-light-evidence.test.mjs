// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { LIGHT_STEPS, LIGHT_TESTS } from "../scripts/ci/light-roster.mjs";

const source = new URL("../scripts/ci/light-runner.mjs", import.meta.url).href;
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
async function put(root, path, content) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
}

// The fixture executes the real runner and all fourteen real child boundaries.
// Only repository child programs are tiny stand-ins; there is no injected runner,
// forged spawn result, replaced roster, or test-only production option.
async function fixture(t, variant = "green") {
  const root = await mkdtemp(join(tmpdir(), "einzbern-light-"));
  let retain = false;
  t.after(() => retain ? t.diagnostic(`Retained failed light fixture: ${root}`) : rm(root, { recursive: true, force: true }));
  for (const path of ["home", "device", "tmp", "evidence", "scripts"]) await mkdir(join(root, path), { recursive: true });
  await copyFile(new URL("../scripts/no-network.mjs", import.meta.url), join(root, "scripts/no-network.mjs"));
  const reports = Object.fromEntries(LIGHT_STEPS.filter(row => row.kind === "receipt").map(row => [row.id, row.expected[0]]));
  await put(root, "scripts/task.mjs", `
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const id = process.argv[2];
if (${JSON.stringify(variant)} === 'build-red' && id === 'build') { console.error('NESTED_TYPECHECK_FIXTURE_RED'); process.exit(23); }
const receipt = { ok: true, reasonCode: ${JSON.stringify(reports)}[id] };
if (id === 'archive') {
  mkdirSync('dist/source', { recursive: true });
  const bytes = Buffer.from('SOURCE_ARCHIVE_FIXTURE_BYTES');
  writeFileSync('dist/source/einzbern-source.tar', bytes);
  receipt.path = 'dist/source/einzbern-source.tar'; receipt.sha256 = createHash('sha256').update(bytes).digest('hex');
}
if (id === 'privacy') {
  if (process.env.EINZBERN_PRIVACY_HISTORY_BASE !== '') process.exit(24);
  receipt.privacyScope = 'HEAD-reachable'; receipt.archiveScanned = true;
  if (${JSON.stringify(variant)} === 'archive-changed') writeFileSync('dist/source/einzbern-source.tar', 'CHANGED');
}
console.log(JSON.stringify(receipt));
`);
  await put(root, "scripts/test-wiring-proof.mjs", `console.log(JSON.stringify({ok:true,reasonCode:'TEST_WIRING_VERIFIED'}));\n`);
  for (const path of ["portal/scripts/proof.mjs", "scripts/ds-component-css-reconcile.mjs", "scripts/ds-component-css-proof.mjs"]) await put(root, path, "console.log('BOUNDED_FIXTURE_PROCESS');\n");
  const probe = `
import assert from 'node:assert/strict';
import { get } from 'node:http';
import { Socket } from 'node:net';
import { lookup } from 'node:dns/promises';
// These checks happen before any attempted transport: a missing preload cannot
// accidentally turn a negative guard test into a real network request.
assert.equal(globalThis.__TCRN_OFFLINE_GUARD__, true, 'PRETRANSPORT_GUARD_MISSING');
assert.equal(process.env.COREPACK_ENABLE_NETWORK, '0');
assert.equal(process.env.npm_config_offline, 'true');
assert.equal(process.env.TCRN_OFFLINE_PROOF, '1');
assert.equal(process.env.NODE_OPTIONS, ${JSON.stringify(`--import=${pathToFileURL(join(root, "scripts/no-network.mjs")).href}`)}, 'PRETRANSPORT_OPTIONS_CHANGED');
await assert.rejects(fetch('http://192.0.2.1/'), {code:'OFFLINE_NETWORK_BLOCKED'});
assert.throws(() => get('http://192.0.2.1/'), {code:'OFFLINE_NETWORK_BLOCKED'});
assert.throws(() => new Socket().connect(9, '192.0.2.1'), {code:'OFFLINE_NETWORK_BLOCKED'});
await assert.rejects(lookup('fixture.invalid'), {code:'OFFLINE_NETWORK_BLOCKED'});
console.log('GUARDED_CHILD_BYTES');
`;
  await put(root, "guard-probe.mjs", probe);
  await put(root, "empty-preload.mjs", "// Deliberately does not install a guard.\n");
  for (const [index, path] of LIGHT_TESTS.entries()) {
    await put(root, path, index === 0 ? `
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
${probe}
test('guard reaches ordinary fresh Node descendants; advisory-only controls fail before transport', () => {
  const results = [];
  for (const options of [process.env.NODE_OPTIONS, '', '--import=' + pathToFileURL(${JSON.stringify(join(root, "empty-preload.mjs"))}).href]) {
    const child = spawnSync(process.execPath, [${JSON.stringify(join(root, "guard-probe.mjs"))}], {encoding:'utf8', env:{...process.env, NODE_OPTIONS:options, TCRN_OFFLINE_PROOF:'1', npm_config_offline:'true', COREPACK_ENABLE_NETWORK:'0'}});
    results.push({exitCode:child.status, signal:child.signal, stdout:child.stdout, stderr:child.stderr});
  }
  writeFileSync(${JSON.stringify(join(root, "descendants.json"))}, JSON.stringify(results));
  assert.equal(results[0].exitCode, 0); assert.match(results[0].stdout, /GUARDED_CHILD_BYTES/);
  for (const result of results.slice(1)) { assert.notEqual(result.exitCode, 0); assert.match(result.stderr, /PRETRANSPORT_GUARD_MISSING/); assert.doesNotMatch(result.stdout, /GUARDED_CHILD_BYTES/); }
});
` : `import test from 'node:test'; test('bounded fixture ${index}', () => {});\n`);
  }
  const env = { ...process.env, HOME: join(root, "home"), EINZBERN_HOME: join(root, "device"), TMPDIR: join(root, "tmp"), EINZBERN_CI_EVIDENCE_DIR: join(root, "evidence"), npm_config_offline: "false", COREPACK_ENABLE_NETWORK: "1", EINZBERN_PRIVACY_HISTORY_BASE: "must-be-replaced" };
  // This models a standalone CI controller, not a recursive node:test worker.
  // Keep every production guard/offline variable; only remove harness bookkeeping.
  delete env.NODE_TEST_CONTEXT;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `import {runLight} from ${JSON.stringify(source)}; const result=await runLight(${JSON.stringify(root)}); console.log(JSON.stringify(result)); process.exitCode=result.ok?0:1;`], { env, encoding: "utf8", timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
  retain = child.error !== undefined || child.signal !== null || (variant === "green" && child.status !== 0);
  if (retain) {
    await put(root, "runner.stdout", child.stdout ?? "");
    await put(root, "runner.stderr", child.stderr ?? "");
    await put(root, "runner-result.json", JSON.stringify({ status: child.status, signal: child.signal, error: child.error?.message }));
  }
  assert.equal(child.signal, null, child.stderr);
  assert.equal(child.error, undefined, child.stderr);
  const result = JSON.parse(await readFile(join(root, "evidence/light.json"), "utf8"));
  return { root, child, result };
}

test("real light children retain raw bytes, official preload and inherited guarded descendants", async t => {
  const { root, child, result } = await fixture(t);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(result.ok, true);
  assert.equal(result.coverage, "light");
  assert.deepEqual(result.steps.map(row => row.id), LIGHT_STEPS.map(row => row.id));
  for (const row of result.steps) {
    const retained = JSON.parse(await readFile(join(root, "evidence/steps", `${row.id}.json`), "utf8"));
    assert.deepEqual(retained, row);
    assert.equal(row.exitCode, 0);
    assert.equal(row.signal, null);
    assert.equal(row.noNetwork.sha256, hash(await readFile(join(root, "scripts/no-network.mjs"))));
    await readFile(join(root, "evidence/steps", `${row.id}.stdout`));
    await readFile(join(root, "evidence/steps", `${row.id}.stderr`));
  }
  const descendants = JSON.parse(await readFile(join(root, "descendants.json"), "utf8"));
  assert.deepEqual(descendants.map(row => row.exitCode), [0, 1, 1]);
  assert.match(await readFile(join(root, "evidence/steps/contracts.stdout"), "utf8"), /GUARDED_CHILD_BYTES/u);
  const archive = await readFile(join(root, "evidence/source-archive.tar"));
  assert.equal(result.sourceArchive.sha256, hash(archive));
  assert.equal(result.sourceArchive.bytes, archive.length);
});

test("a failed build child keeps its original failure bytes and blocks dependent contracts/proofs", async t => {
  const { root, child, result } = await fixture(t, "build-red");
  assert.equal(child.status, 1);
  assert.equal(result.ok, false);
  const build = result.steps.find(row => row.id === "build");
  assert.equal(build.exitCode, 23);
  assert.match(await readFile(join(root, "evidence/steps/build.stderr"), "utf8"), /NESTED_TYPECHECK_FIXTURE_RED/u);
  for (const id of ["contracts", "portal-proof", "retrieval-eval"]) {
    const step = result.steps.find(row => row.id === id);
    assert.equal(step.status, "blocked");
    assert.equal(step.exitCode, null);
    assert.equal(step.ok, false);
    assert.equal(await readFile(join(root, "evidence/steps", `${id}.stdout`), "utf8"), "");
  }
});

test("archive mutation during an otherwise green privacy child cannot produce light success", async t => {
  const { child, result } = await fixture(t, "archive-changed");
  assert.equal(child.status, 1);
  const privacy = result.steps.find(row => row.id === "privacy");
  assert.equal(privacy.exitCode, 0);
  assert.equal(privacy.ok, false);
  assert.ok(privacy.problems.includes("CI_LIGHT_SOURCE_ARCHIVE_CHANGED"));
});

// Deliberately synthetic wrapper metadata surrounds *actual* child streams here.
// This exercises the downloaded-byte verifier, not wrapper preflight or a claim
// that the fixture is an accepted production run. Full wrapper/smoke acceptance
// is separate; all mutations below are resealed where appropriate so metadata
// flags alone cannot make the verifier pass.
test("downloaded light evidence replays raw bytes and refuses resealed semantic corruption", async t => {
  const { root } = await fixture(t);
  const aggregatePath = new URL("../scripts/ci/aggregate-evidence.py", import.meta.url).pathname;
  const program = String.raw`
import copy, hashlib, importlib.util, json, shutil, sys
from pathlib import Path
spec = importlib.util.spec_from_file_location('aggregate', sys.argv[1])
a = importlib.util.module_from_spec(spec); spec.loader.exec_module(a)
root = Path(sys.argv[2]); evidence = root / 'evidence'
sha = 'a' * 40
roster = json.loads((evidence / 'light-roster.json').read_text())
final = json.loads((evidence / 'light.json').read_text())
def put(path, value): path.write_text(json.dumps(value))
def rec(path, name): return {**a.evidence_runner.file_receipt(path), 'file':name}
guard = root / 'scripts/no-network.mjs'
manifest = {'files':[{'path':'scripts/no-network.mjs','size':guard.stat().st_size,'sha256':hashlib.sha256(guard.read_bytes()).hexdigest()}]}
identity = {'head':sha,'tree':'b'*40,'statusPorcelainAll':''}
meta = {'schemaVersion':'einzbern.ci-light-evidence.v1','mode':'ci-light','coverage':'light','cwd':str(root),'errors':[],'exitCode':0,
 'fixtures':{'tmp':{'checksPassed':True},'device':{'checksPassed':True}},'input':identity,'output':identity,
 'inputManifest':manifest,'outputManifest':manifest,'retainedArtifactsVerified':True,
 'environment':{'EINZBERN_PRIVACY_HISTORY_BASE':''},'finalLightReceipt':final,'finalReceiptStream':'stdout',
 'receipt':{'ok':True,'reasonCode':'CI_LIGHT_EVIDENCE_RETAINED'},
 'ciIdentity':{'GITHUB_RUN_ID':'91','GITHUB_RUN_ATTEMPT':'2','GITHUB_JOB':'ci-light'}}
meta['testTotals']=a.evidence_runner.parse_test_totals((evidence/'steps/contracts.stdout').read_bytes())
put(evidence/'fixture-location.json',meta['fixtures']); put(evidence/'source-before.json',manifest); put(evidence/'source-after.json',manifest)
put(evidence/'ci-light.stdout',final); (evidence/'ci-light.stderr').write_bytes(b'')
put(evidence/'receipt.json',meta['receipt'])
def seal(directory, value):
 value['stdout']=rec(directory/'ci-light.stdout','ci-light.stdout'); value['stderr']=rec(directory/'ci-light.stderr','ci-light.stderr')
 value['artifactFiles']={name:rec(directory/name,name) for name in ['fixture-location.json','source-before.json','source-after.json']}
 names=['light.json','light-roster.json','source-archive.tar'] + [f'steps/{row["id"]}{suffix}' for row in roster['steps'] for suffix in ['.json','.stdout','.stderr']]
 value['extraArtifacts']={name:rec(directory/name,name) for name in names if (directory/name).is_file()}
 put(directory/'ci-light.meta.json',value)
seal(evidence,meta)
_, errors = a.validate_light_directory(evidence,sha,roster)
assert errors == [], errors
results=[]
def negative(name, mutate, reseal=True):
 directory=root/('mutation-'+name); shutil.copytree(evidence,directory)
 value=copy.deepcopy(meta); mutate(directory,value)
 if reseal:
  put(directory/'light.json',value['finalLightReceipt']); put(directory/'ci-light.stdout',value['finalLightReceipt'])
  seal(directory,value)
 try: _, errors=a.validate_light_directory(directory,sha,roster)
 except Exception as error: errors=[str(error)]
 assert errors, name+' was falsely accepted'
 results.append({'case':name,'refused':True})
def change_step(directory,value,key,patch):
 step=next(row for row in value['finalLightReceipt']['steps'] if row['id']==key); step.update(patch); put(directory/f'steps/{key}.json',step)
negative('altered-summary',lambda d,m:m['testTotals'].update(tests=999))
negative('raw-byte-corruption',lambda d,m:(d/'steps/build.stdout').write_bytes(b'corrupt'),False)
negative('missing-raw',lambda d,m:(d/'steps/build.stderr').unlink())
negative('extra-raw',lambda d,m:(d/'unexpected').write_bytes(b'extra'))
negative('duplicate-step',lambda d,m:m['finalLightReceipt']['steps'].append(copy.deepcopy(m['finalLightReceipt']['steps'][0])))
negative('missing-step',lambda d,m:m['finalLightReceipt']['steps'].pop())
negative('reordered-step',lambda d,m:m['finalLightReceipt']['steps'].reverse())
negative('failed-exit',lambda d,m:change_step(d,m,'build',{'exitCode':23}))
negative('cancelled',lambda d,m:change_step(d,m,'build',{'exitCode':None,'signal':'SIGTERM'}))
negative('timed-out',lambda d,m:change_step(d,m,'build',{'status':'timed_out'}))
negative('blocked',lambda d,m:change_step(d,m,'contracts',{'status':'blocked'}))
negative('wrong-argv',lambda d,m:change_step(d,m,'contracts',{'command':['node','--test','tests/other.test.mjs']}))
negative('wrong-guard',lambda d,m:change_step(d,m,'contracts',{'noNetwork':{'url':'file:///wrong','sha256':'0'*64}}))
negative('wrong-roster-digest',lambda d,m:m['finalLightReceipt'].update(rosterDigest='0'*64))
negative('false-full-coverage',lambda d,m:m.update(coverage='full'))
negative('false-na',lambda d,m:m['finalLightReceipt'].update(notRunHere=[]))
negative('local-full-omitted',lambda d,m:m['finalLightReceipt'].update(localValidationRequired=None))
negative('raw-receipt-disagrees',lambda d,m:(d/'steps/build.stdout').write_text(json.dumps({'ok':False,'reasonCode':'BUILD_VERIFIED'})))
negative('ambiguous-receipts',lambda d,m:(d/'steps/build.stderr').write_bytes((d/'steps/build.stdout').read_bytes()))
negative('archive-bytes-changed',lambda d,m:(d/'source-archive.tar').write_bytes(b'changed'))
def replace_link(d,m):
 p=d/'steps/build.stdout'; p.unlink(); p.symlink_to(evidence/'steps/build.stdout')
negative('symlink',replace_link,False)
_, wrong_sha=a.validate_light_directory(evidence,'c'*40,roster); assert wrong_sha
for mode in ['p1','pf2-h1','p1-core','p1-checks','p1-portal']:
 value=copy.deepcopy(meta); value['mode']=mode
 assert a.evidence_runner.evaluate(value), mode+' accepted light as full'
# Bundle proof uses an actual tiny Git source tree and the verifier's real roster.
# No network, remote API, claimed production run or production commit is involved.
import subprocess
repo=root/'verifier'; (repo/'scripts/ci').mkdir(parents=True)
source=Path(sys.argv[1]).parents[2]
for name in ['scripts/ci/light-roster.mjs','scripts/p1-sequence.mjs','scripts/no-network.mjs']:
 shutil.copyfile(source/name,repo/name)
def git(*args): return subprocess.check_output(['git','-C',str(repo),*args],stderr=subprocess.PIPE,text=True).strip()
git('init','--quiet'); git('add','scripts')
git('-c','user.name=Fixture','-c','user.email=fixture-identity','-c','commit.gpgsign=false','commit','--quiet','-m','isolated evidence fixture')
sha=git('rev-parse','HEAD'); tree=git('rev-parse','HEAD^{tree}')
bundle=root/'bundle'; bundle.mkdir(); target=bundle/f'ci-light-evidence-{sha}-2'; shutil.copytree(evidence,target)
bound=copy.deepcopy(meta); bound['input']={'head':sha,'tree':tree,'statusPorcelainAll':''}; bound['output']=bound['input']
bound['inputManifest']={'files':a.git_source_files(repo,sha)}; bound['outputManifest']=bound['inputManifest']
put(target/'source-before.json',bound['inputManifest']); put(target/'source-after.json',bound['inputManifest']); seal(target,bound)
package=bundle/f'package-smoke-{sha}-2'; package.mkdir()
(package/'source-head.txt').write_text(sha+'\n'); (package/'fixture.tar.gz').write_bytes(b'PACKAGE_FIXTURE')
(package/'fixture.tar.gz.sha256').write_text(hashlib.sha256(b'PACKAGE_FIXTURE').hexdigest()+'  fixture.tar.gz')
for name,reason in [('install.json','INSTALL_ENGINE_READY'),('setup-plan.json','SETUP_PLAN_READY'),('setup-applied.json','SETUP_APPLIED'),('doctor.json','DOCTOR_READY'),('init.json','LIBRARY_CREATED'),('status.json','WORKSPACE_COMMAND_COMPLETED'),('commands.json','CLI_CATALOG_READY')]:
 put(package/name,{'ok':True,'reasonCode':reason,**({'checks':[{'ok':True} for _ in range(8)]} if name=='doctor.json' else {}),**({'blockers':[]} if name=='setup-plan.json' else {}),**({'selfCheck':{'checks':[{'ok':True}]}} if name=='setup-applied.json' else {})})
put(package/'package-seal.json',{'identity':{'head':sha,'tree':tree,'runId':'91','attempt':'2','rosterDigest':roster['rosterDigest']},'files':{p.name:{'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in package.iterdir()}})
_,errors,_=a.validate_light_bundle(bundle,sha,'91','2',repo); assert errors==[],errors
for name,patch in [('run',{'GITHUB_RUN_ID':'92'}),('attempt',{'GITHUB_RUN_ATTEMPT':'3'}),('job',{'GITHUB_JOB':'p1'})]:
 changed=copy.deepcopy(bound); changed['ciIdentity'].update(patch); seal(target,changed)
 _,errors,_=a.validate_light_bundle(bundle,sha,'91','2',repo); assert errors,name; results.append({'case':'bundle-'+name,'refused':True})
seal(target,bound)
changed=copy.deepcopy(bound); changed['input']['tree']='e'*40; changed['output']=changed['input']; seal(target,changed)
_,errors,_=a.validate_light_bundle(bundle,sha,'91','2',repo); assert errors; results.append({'case':'bundle-tree','refused':True})
changed=copy.deepcopy(bound); changed['inputManifest']['files'][0]['sha256']='f'*64; changed['outputManifest']=changed['inputManifest']
put(target/'source-before.json',changed['inputManifest']); put(target/'source-after.json',changed['inputManifest']); seal(target,changed)
_,errors,_=a.validate_light_bundle(bundle,sha,'91','2',repo); assert errors; results.append({'case':'bundle-source-bytes','refused':True})
print(json.dumps(results))
`;
  const child = spawnSync("python3", ["-B", "-c", program, aggregatePath, root], { encoding: "utf8", timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(child.status, 0, child.stderr);
  const results = JSON.parse(child.stdout);
  assert.equal(results.length, 26);
  assert.ok(results.every(row => row.refused));
});

test("package smoke rereads sealed bytes and requires install/setup/doctor outcomes and exact light identity", async t => {
  const root = await mkdtemp(join(tmpdir(), "einzbern-light-seal-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const aggregatePath = new URL("../scripts/ci/aggregate-evidence.py", import.meta.url).pathname;
  const program = String.raw`
import copy, hashlib, importlib.util, json, shutil, sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('aggregate',sys.argv[1]); a=importlib.util.module_from_spec(spec); spec.loader.exec_module(a)
root=Path(sys.argv[2]); package=root/'package'; package.mkdir()
identity={'profile':'ci-light','head':'a'*40,'tree':'b'*40,'runId':'91','attempt':'2','rosterDigest':'c'*64}
(package/'source-head.txt').write_text(identity['head']+'\n')
(package/'fixture.tar.gz').write_bytes(b'SYNTHETIC_ARCHIVE_NOT_A_RELEASE')
(package/'fixture.tar.gz.sha256').write_text(hashlib.sha256((package/'fixture.tar.gz').read_bytes()).hexdigest()+'  fixture.tar.gz\n')
reasons={'install.json':'INSTALL_ENGINE_READY','setup-plan.json':'SETUP_PLAN_READY','setup-applied.json':'SETUP_APPLIED','doctor.json':'DOCTOR_READY','init.json':'LIBRARY_CREATED','status.json':'WORKSPACE_COMMAND_COMPLETED','commands.json':'CLI_CATALOG_READY'}
for name,reason in reasons.items():
 value={'reasonCode':reason,'ok':True}
 if name=='doctor.json': value['checks']=[{'ok':True} for _ in range(8)]
 if name=='setup-plan.json': value['blockers']=[]
 if name=='setup-applied.json': value['selfCheck']={'checks':[{'ok':True}]}
 (package/name).write_text(json.dumps(value))
def seal(directory):
 files={p.name:{'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in directory.iterdir() if p.name!='package-seal.json'}
 (directory/'package-seal.json').write_text(json.dumps({'identity':{k:v for k,v in identity.items() if k!='profile'},'files':files}))
seal(package); a.validate_package(package,identity)
results=[]
def negative(name,mutate,reseal=False):
 directory=root/name; shutil.copytree(package,directory); target=copy.deepcopy(identity); mutate(directory,target)
 if reseal: seal(directory)
 try: a.validate_package(directory,target)
 except Exception: results.append(name); return
 raise AssertionError(name+' was falsely accepted')
for key in ['head','tree','runId','attempt','rosterDigest']:
 negative('identity-'+key,lambda d,i,key=key:i.update({key:'wrong'}))
negative('corrupt-byte',lambda d,i:(d/'fixture.tar.gz').write_bytes(b'changed'))
negative('missing-file',lambda d,i:(d/'setup-plan.json').unlink())
negative('extra-file',lambda d,i:(d/'extra').write_text('extra'))
for name in ['install.json','setup-plan.json','setup-applied.json','doctor.json']:
 negative('red-'+name,lambda d,i,name=name:(d/name).write_text(json.dumps({'ok':False,'reasonCode':'FIXTURE_FAILED'})),True)
negative('setup-blockers',lambda d,i:(d/'setup-plan.json').write_text(json.dumps({'reasonCode':'SETUP_PLAN_READY','blockers':['blocked']})),True)
negative('setup-self-check',lambda d,i:(d/'setup-applied.json').write_text(json.dumps({'reasonCode':'SETUP_APPLIED','selfCheck':{'checks':[{'ok':False}]}})),True)
negative('doctor-false-check',lambda d,i:(d/'doctor.json').write_text(json.dumps({'ok':True,'reasonCode':'DOCTOR_READY','checks':[{'ok':False}]})),True)
negative('digest-resealed-wrong',lambda d,i:(d/'fixture.tar.gz.sha256').write_text('0'*64+'  fixture.tar.gz'),True)
def symlink(d,i):
 p=d/'install.json'; p.unlink(); p.symlink_to(package/'install.json')
negative('symlink',symlink)
print(json.dumps(results))
`;
  const child = spawnSync("python3", ["-B", "-c", program, aggregatePath, root], { encoding: "utf8", timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout).length, 17);
});
