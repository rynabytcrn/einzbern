// SPDX-License-Identifier: Apache-2.0
// Ordinary sequential disposable regression fixtures; no crash, race, or real-device probes.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asPinnedDevice } from './helpers/device-home.mjs';
import { restoreLegacyFixture } from './helpers/legacy-fixture.mjs';
import { assertDistinctRootShape } from '../dist/build/packages/core/src/root-identity.js';
import { SegmentedKnowledgeStoreBackend } from '../dist/build/packages/core/src/store-backend.js';
import { canonicalJson, createEvent, eventInputOf } from '../dist/build/packages/protocol/src/index.js';
import { importLegacyWorkspace, readAllStreams, initializeLibrary, createProject, initializeKnowledgeStore } from '../dist/build/packages/core/src/index.js';
import { userCrestSnapshotPath } from '../dist/build/packages/core/src/device-home.js';
import { runCli } from '../dist/build/packages/cli/src/index.js';
import { planCommand, migrateCommand } from '../scripts/knowledge-language.mjs';
import { recordCorpus } from '../scripts/retrieval-eval-record.mjs';
const at = '2026-09-26T06:00:00Z';
async function scratch(t) { const p = await mkdtemp(join(tmpdir(), 'storage-maintenance-')); t.after(() => rm(p, {recursive:true,force:true})); return p; }
async function cli(args) { let out=''; await runCli(args,{write: s=>{out+=s;}}); return JSON.parse(out); }

test('distinct roots reject a nested dot-prefix directory, not a sibling', () => {
 const kinds=['framework','workspace','transient','evidence-locator','release-trust'];
 const roots=kinds.map((kind,i)=>({kind,canonicalPath:`/fixture/root${i}`}));
 roots[1].canonicalPath='/fixture/root0/..cache';
 assert.throws(()=>assertDistinctRootShape(roots),{reasonCode:'ROOT_PATH_CONTAINMENT'});
 roots[1].canonicalPath='/fixture/..cache';
 assert.doesNotThrow(()=>assertDistinctRootShape(roots));
});

test('segmented indexes beyond one MiB remain readable with integrity checks',async()=>{
 const files=new Map(Array.from({length:12000},(_,i)=>[`knowledge:${i.toString(16).padStart(24,'0')}.body`,Buffer.from('x')]));
 const delegate={
  async listKnowledgeBodyFiles(){return [...files.keys()];},
  async readKnowledgeBodyFile(n,limit){const b=files.get(n); assert.ok(b); assert.ok(b.length<=limit,`${n} exceeds reader limit`); return b;},
  async readKnowledgeBody(id){return files.get(`${id}.body`);},
  async writeKnowledgeBodyFile(n,b){files.set(n,Buffer.from(b));},
  async removeKnowledgeBodyFile(n){files.delete(n);}
 };
 const backend=new SegmentedKnowledgeStoreBackend(delegate);
 await backend.migrateKnowledgeBodies();
 assert.ok([...files].some(([n,b])=>n.endsWith('.idx')&&b.length>1048576));
 const fresh=new SegmentedKnowledgeStoreBackend(delegate);
 assert.equal((await fresh.readKnowledgeBody('knowledge:000000000000000000000000')).toString(),'x');
 const manifest=JSON.parse(files.get('manifest.json')); manifest.count++;
 files.set('manifest.json',Buffer.from(canonicalJson(manifest)));
 await assert.rejects(fresh.readKnowledgeBody('knowledge:000000000000000000000000'),{reasonCode:'KNOWLEDGE_RECORD_INVALID'});
});

for(const clock of [46,35]) test(`legacy stream import preflights clock ${clock} and preserves source bytes`,async t=>asPinnedDevice(async()=>{
 const base=await scratch(t); const fixture=await restoreLegacyFixture(base);
 const name=(await readdir(fixture.events)).filter(n=>n.endsWith('.ndjson')).sort().at(-1);
 const path=join(fixture.events,name); const events=(await readFile(path,'utf8')).trim().split('\n').map(JSON.parse);
 const last=events.at(-1); events[events.length-1]=createEvent({...eventInputOf(last),clock,deviceId:'a'.repeat(32)},'einzbern.event.v1');
 const bytes=events.map(e=>canonicalJson(e).trimEnd()).join('\n')+'\n'; await writeFile(path,bytes);
 const target=join(base,'imported');
 if(clock===35){
  for(const dryRun of [true,false]) await assert.rejects(importLegacyWorkspace(fixture.root,target,{createdAt:at,dryRun}),{reasonCode:'LEGACY_IMPORT_MISMATCH'});
  await assert.rejects(stat(target),{code:'ENOENT'});
 }else{
  await importLegacyWorkspace(fixture.root,target,{createdAt:at,dryRun:true});
  await importLegacyWorkspace(fixture.root,target,{createdAt:at});
  const streams=await readAllStreams(target);
  assert.equal(streams.streams[0].manifest.clockHighWater,46);
 }
 assert.equal(await readFile(path,'utf8'),bytes);
}));

test('malformed readable crest snapshots rebuild without changing authority',async t=>asPinnedDevice(async home=>{
 const base=await scratch(t); const workspace=join(base,'library');
 await initializeLibrary({root:workspace,createdAt:at});
 await createProject(workspace,{occurredAt:at,externalKey:'SNAP-PROJECT',name:'Snapshot'});
 await initializeKnowledgeStore(workspace,{disposableAcknowledged:true});
 await cli(['knowledge-capture','--workspace',workspace,'--at',at,'--scope','user','--external-key','SNAP-CARD','--subject','Cache fallback','--summary','Cache fallback summary','--snippet','Cache fallback snippet','--tags','cache','--accountable-owner-id','owner:agent-session','--body','Cache fallback body.']);
 const path=userCrestSnapshotPath(home); const snapshot=JSON.parse(await readFile(path,'utf8'));
 async function bytesUnder(root){const result=[]; for(const e of await readdir(root,{withFileTypes:true})){const p=join(root,e.name); if(e.isDirectory())result.push(...await bytesUnder(p));else result.push([p,(await readFile(p)).toString('base64')]);} return result.sort();}
 const authority=await bytesUnder(snapshot.storeRoot);
 for(const broken of [{units:[null]},{removals:[null]},{duplicates:[{id:'bad'}]}]){
  await writeFile(path,JSON.stringify({...snapshot,...broken}));
  assert.equal((await cli(['knowledge-list','--workspace',workspace,'--at',at,'--scope','user'])).total,1);
  assert.deepEqual(await bytesUnder(snapshot.storeRoot),authority);
 }
}));

test('language tooling requests every card and fills missing required expansions',async t=>{
 const base=await scratch(t);const out=join(base,'plan.json'); const bundle=join(base,'bundle.json');await writeFile(bundle,JSON.stringify({model:'offline'}));
 const records=Array.from({length:10},(_,i)=>({id:`card${i}`,subject:'Subject',summary:'Summary',snippet:'Snippet',expansions:{en:['phrase']}}));
 const core={materializeWorkspace:async()=>({settings:[]}),scopedWorkspaceState:s=>s,chainIdentity:()=>null,
 readRuntimeKnowledgeLanguagePolicy:async()=>({artifactLanguage:'en',promptLanguages:['en','fr'],economyModel:'offline'}),
 listKnowledgeMetadata:async(_w,options)=>({records:records.slice(0,options.limit??8)}),detectLanguage:()=> 'en',
 parseLanguageBundle:x=>x,languageProviderFromBundle:()=>({}),applyWriteLanguagePolicy:fields=>({...fields,expansions:{en:['phrase'],fr:['phrase fr']}})};
 await planCommand(core,{workspace:base,out,at}); const plan=JSON.parse(await readFile(out));assert.equal(plan.cards,10);assert.equal(plan.pending,10);
 let text='';const write=process.stdout.write;process.stdout.write=s=>{text+=s;return true;};
 try{await migrateCommand(core,{workspace:base,bundle,at,'dry-run':'true'});}finally{process.stdout.write=write;}
 const result=JSON.parse(text);assert.equal(result.cards,10);assert.equal(result.rewritten,10);
});

test('recorder refuses a dot-prefix output descendant before source access',async()=>{
 await assert.rejects(recordCorpus({source:'/disposable-source',out:'/disposable-source/..cache',at}),{reasonCode:'RETRIEVAL_EVAL_RECORD_OUT_INSIDE_SOURCE'});
});

// Recorder execution also reads host privacy inputs; keep this boundary assertion source-only.
test('recorder all-card request explicitly overrides the default page',async()=>{
 const source=await readFile(new URL('../scripts/retrieval-eval-record.mjs',import.meta.url),'utf8');
 assert.match(source,/listKnowledgeMetadata\(options\.source,\s*\{[^}]*limit:\s*Number\.MAX_SAFE_INTEGER/u);
});
