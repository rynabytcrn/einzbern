// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import test from 'node:test';
import ts from 'typescript';
const legacy = await readFile(new URL('../scripts/platform-doctor.mjs',import.meta.url),'utf8');
function declarations(source,names) {
 const tree=ts.createSourceFile('source.ts',source,ts.ScriptTarget.Latest,true);const found=[];
 for(const node of tree.statements) if(ts.isFunctionDeclaration(node)&&names.includes(node.name?.text)) found.push(node.getText(tree).replace(/^export /u,'').replaceAll('import.meta.url', '"file:///fixture/module.mjs"'));
 assert.equal(found.length,names.length);return found.join('\n');
}
function helper(name,bindings,extras=[]) {return new Function(...Object.keys(bindings),`${declarations(legacy,[name,...extras])}\nreturn ${name};`)(...Object.values(bindings));}
const check=(name,ok,details={})=>({name,ok,...details});
test('bounded host output preserves UTF-8 across chunks and drops only cap-cut tails',async()=>{
 const source=await readFile(new URL('../packages/core/src/host-probe.ts',import.meta.url),'utf8');
 const js=ts.transpile(declarations(source,['appendBounded','decodeBounded']),{target:ts.ScriptTarget.ES2022});
 const {appendBounded,decodeBounded}=new Function('HOST_PROBE_OUTPUT_BYTES','StringDecoder',`${js};return {appendBounded,decodeBounded};`)(7,StringDecoder);
 const bytes=Buffer.from('A😀é');
 for(let split=1;split<bytes.length;split++) {const chunks=[],state={bytes:0,truncated:false};appendBounded(chunks,bytes.subarray(0,split),state);appendBounded(chunks,bytes.subarray(split),state);assert.equal(decodeBounded(chunks,state.truncated),'A😀é');}
 const chunks=[],state={bytes:0,truncated:false};appendBounded(chunks,Buffer.from('12345😀'),state);assert.equal(state.truncated,true);assert.equal(decodeBounded(chunks,true),'12345');assert.equal(state.bytes,7);
});
test('legacy validator refuses malformed or explicitly refused zero-exit output',async()=>{
 for(const stdout of ['not JSON','null','[]','{"ok":false,"reasonCode":"CHAIN_VALIDATED"}','{"reasonCode":"OTHER"}','{"reasonCode":"CHAIN_VALIDATED"}']) {
  const validate=helper('inspectChainValidation',{check,currentChainPartitions:async()=>({ok:true,partitions:[{partition:'fixture',workspacePath:'/fixture/workspace'}]}),execFileAsync:async()=>({stdout}),relative,process},['parseCommandJson']);
  const result=await validate('/fixture',{engineCli:'/fixture/no-execution'});assert.equal(result.ok,stdout==='{"reasonCode":"CHAIN_VALIDATED"}');
 }
});
test('legacy storage missing metadata cannot erase preceding failed partition',async()=>{
 const inspect=helper('inspectWorkspaceStorageShape',{check,join,WORKFLOW_DIRECTORY:'.control',WORKSPACE_STORAGE_MIGRATION_SEGMENT_BYTES:4194304,readdir:async()=>['a','b'].map(name=>({name,isDirectory:()=>true})),existingPath:async()=>({isDirectory:()=>true}),readFile:async path=>{if(path.includes('/a/'))return JSON.stringify({storageVersion:1});throw Object.assign(new Error('missing'),{code:'ENOENT'});}});
 for(const options of [{},{acceptanceHeadCommit:'synthetic'}]) {const result=await inspect('/fixture',options);assert.equal(result.ok,false);assert.equal(result.partitions.length,2);assert.equal(result.partitions[0].ok,false);}
});
test('legacy capability comparison reports command attribute differences',()=>{
 const compare=helper('engineCapabilitySurfaceVerdict',{check,createHash,compareCanonicalTextLocal:(a,b)=>a<b?-1:a>b?1:0},['normalizeCommandCatalog']);
 const base=[{name:'read',availability:'both',mutates:false,flags:[]}];
 for(const change of [{mutates:true},{availability:'model'}]) {const result=compare(base,[{...base[0],...change}],'fixture');assert.equal(result.capabilitySurface,'ATTRIBUTES_DIVERGENT');assert.equal(result.attributeDifferences.length,1);}
});
test('legacy freshness rejects future receipts',async()=>{
 const read=helper('readFreshnessReceipt',{readFile:async()=>JSON.stringify({ok:true,snapshotSha256:'digest',chainVersions:{},finishedAt:'2999-01-01T00:00:00Z'})});
 assert.equal((await read('/fixture',24,'local')).ok,false);
});
test('cleanup verifies regular retained snapshot before any removal (source order)',async()=>{
 const source=await readFile(new URL('../scripts/archive-cleanup.mjs',import.meta.url),'utf8');
 const apply=declarations(source,['applyArchiveCleanup']);
 assert.ok(apply.indexOf('retained?.isFile()')<apply.indexOf('await rm('));assert.match(apply,/directory\.isSymbolicLink/);assert.match(apply,/retained\.isSymbolicLink/);
 // Deliberately no invocation of destructive cleanup.
});
