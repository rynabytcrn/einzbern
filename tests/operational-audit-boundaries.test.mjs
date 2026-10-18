// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizePhaseAwareImpact, buildDynamicGatePlan, createGateReceiptAuthority, issueGateReceipt, executeSelectedRoots } from '../scripts/final-gate-plan.mjs';
import { classifyProcess, requireGitObservation } from '../scripts/operational-batch-entry.mjs';
import { parseTestRunOutput } from '../scripts/review-evidence.mjs';
import { verifyCloseout } from '../scripts/closeout-verify.mjs';
import { evidenceExitMatches, runBatchDocument, validEvidenceEntry } from '../scripts/closeout-evidence-runner.mjs';
import { parseChainReadResult } from '../scripts/owner-queue.mjs';
import { selectSimulatedTail } from '../scripts/compaction-prototype.mjs';
const root = new URL('../', import.meta.url).pathname.replace(/\/$/u, '');
test('production environment alias preserves unknown impact and precedence', () => {
  assert.equal(normalizePhaseAwareImpact({environment:[{name:'runtime',known:false}]}).environment[0].known,false);
  assert.deepEqual(normalizePhaseAwareImpact({environment:[{name:'runtime'}],environmentChanges:[]}).environment,[]);
});
test('ps modifiers and unknown states do not erase relative repository activity', () => {
  for (const state of ['Sl','Ssl','R+','D','?']) {
    const row=classifyProcess({pid:123456,state,command:'node scripts/task.mjs build'},{selfPid:1});
    assert.equal(row.active,true); assert.equal(row.scope,'unknown');
  }
});
test('task success marker required, contradictions refused, valid writer preserved', () => {
  for (const extra of [{},{ok:false},{result:'failed'},{ok:true,result:'failed'},{ok:false,result:'passed'}]) assert.equal(parseTestRunOutput(JSON.stringify({tests:['tests/a.test.mjs'],...extra})).parseable,false);
  assert.equal(parseTestRunOutput(JSON.stringify({tests:['tests/a.test.mjs'],result:'passed'})).parseable,true);
});
test('malformed closeout containers and ids return refusals', () => {
  for (const manifest of [null,{}, {items:{}},{items:'x'},{items:[''],dispositions:{'':{kind:'fixed'}}},{items:['a'],dispositions:[]}]) assert.equal(verifyCloseout(manifest).ok,false);
});
test('expected failure means completed nonzero exit, not transport failure', () => {
  assert.equal(evidenceExitMatches({status:1},'nonzero'),true);
  for (const result of [{status:null},{status:1,signal:'SIGTERM'},{status:1,error:{code:'ENOENT'}},{status:0}]) assert.equal(evidenceExitMatches(result,'nonzero'),false);
});
test('chain read requires successful completion and stdout records, not literal ok true', () => {
  for (const payload of [{records:[]},{result:{records:[]}},{ok:true,records:[]}]) assert.equal(parseChainReadResult({code:0,stdout:JSON.stringify(payload)}).ok,true);
  for (const input of [{code:1,stdout:'{"records":[]}'},{code:null,signal:'SIGTERM',stdout:'{"records":[]}'},{code:0,stderr:'{"records":[]}'},{code:0,stdout:'{}'},{code:0,stdout:'{"ok":false,"records":[]}'}]) assert.equal(parseChainReadResult(input).ok,false);
});
test('failed code-owned receipt remains a failed executed row, never green', async () => {
  const rosterPath=`${root}/tests/fixtures/acceptance-gate-groups.json`;
  const roster=JSON.parse(readFileSync(rosterPath));
  const containment=JSON.parse(readFileSync(`${root}/scripts/policy/gate-containment.json`));
  const inputs={sourceDigest:'s',environmentDigest:'e',commandDigest:'c',baselineDigest:'b'};
  const authority=createGateReceiptAuthority();
  const invocation={executable:'node',argv:['scripts/push-gate.mjs'],cwd:root,command:'node scripts/push-gate.mjs'};
  const plan=buildDynamicGatePlan({roster,containment,inputs,changedFiles:['scripts/final-gate-plan.mjs'],dependencies:[],configuration:[],generated:[],environment:[],crossRepoChanges:[],candidateReady:true,executionPermission:true,operational:true,requireCompleteImpact:true,receiptAuthority:authority,gateInvocations:{'engine-release':invocation}});
  const result=await executeSelectedRoots(plan,entry=>issueGateReceipt(authority,{entry,result:{ok:false,status:1,stdout:'failure'},inputs,invocation}),{getInputs:()=>inputs,rosterPath});
  assert.equal(result.executable,false); assert.equal(result.executed.length,1); assert.equal(result.executed[0].status,'failed'); assert.equal(result.executed[0].ok,false); assert.notEqual(result.executed[0].reasonCode,'GATE_PLAN_TERMINAL_EVIDENCE_INVALID');
});

test('failed Git observation cannot become successful empty output', () => {
  assert.equal(requireGitObservation({ok:true,status:0,stdout:''},'diff'),'');
  for (const result of [{ok:false,status:1,stdout:''},{ok:false,status:null,error:'unavailable'},{ok:true,status:null,signal:'SIGTERM',stdout:''}]) assert.throws(()=>requireGitObservation(result,'diff'),{reasonCode:'BATCH_GIT_OBSERVATION_FAILED'});
});
test('all-cold simulation selects no records, nonzero tail retains correct suffix', () => {
  assert.deepEqual(selectSimulatedTail([1,2,3],0),[]);
  assert.deepEqual(selectSimulatedTail([1,2,3],2),[2,3]);
});

test('invalid later execution options refuse the whole batch before the first runner call', () => {
  const good = {program:'node',args:['fixture.mjs']};
  for (const change of [{dir:42},{dir:null},{dir:'bad\0path'},{timeoutMs:-1},{timeoutMs:1.5},{timeoutMs:'100'},{timeoutMs:null},{timeoutMs:2_147_483_648},{cmd:' '},{cmd:42},{args:['bad\0arg']}]) {
    let calls=0;
    const result=runBatchDocument({incidents:[{id:'one',evidence:[good]},{id:'two',evidence:[{...good,...change}]}]}, {run:()=>{calls++;return {ok:true};}});
    assert.equal(result.reasonCode,'BATCH_EVIDENCE_INVALID'); assert.equal(calls,0);
  }
  for (const entry of [good,{...good,dir:'',timeoutMs:0},{...good,dir:'.',timeoutMs:180_000},{cmd:' node fixture.mjs ',expectedExit:'nonzero'}]) assert.equal(validEvidenceEntry(entry),true);
  let calls=0;
  const green=runBatchDocument({incidents:[{id:'one',evidence:[good,good]}]}, {run:()=>{calls++;return {ok:true};}});
  assert.equal(green.ok,true); assert.equal(calls,2);
});
