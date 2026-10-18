// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
const server = await readFile(new URL("../portal.mjs", import.meta.url), "utf8");
const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
function declaration(source, name) {
  const parsed = ts.createSourceFile("source.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let found;
  const visit = node => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node.getText(parsed);
    if (ts.isVariableDeclaration(node) && node.name.getText(parsed) === name) found = `const ${node.getText(parsed)};`;
    ts.forEachChild(node, visit);
  };
  visit(parsed); assert.ok(found, name); return found;
}
const browser = html.slice(html.indexOf('<script type="module">') + '<script type="module">'.length, html.lastIndexOf('</script>'));
function extract(source, name, bindings) {
  return new Function(...Object.keys(bindings), `${declaration(source, name)}\nreturn ${name};`)(...Object.values(bindings));
}
test("knowledge inventory reads every page and refuses incomplete or changing inventories", async () => {
  const all = Array.from({length: 205}, (_, n) => ({id: `knowledge:${n}`}));
  const calls = [];
  const projection = extract(server, "knowledgeProjection", {
    currentLibrary: () => ({libraryPath: "/fixture"}), readInstant: () => "2026-10-18T00:00:00Z",
    cliResult: async args => { const offset = Number(args[args.indexOf('--offset') + 1]); calls.push(offset); return {ok:true, body:{total:all.length, records:all.slice(offset, offset+100)}}; },
  });
  const result = await projection(); assert.equal(result.ok,true); assert.equal(result.records.length,205); assert.deepEqual(calls,[0,100,200]);
  for (const body of [{total:2,records:[]},{total:2,records:[{id:'same'},{id:'same'}]}]) {
    const bad = extract(server, "knowledgeProjection", {currentLibrary:()=>({libraryPath:'/fixture'}),readInstant:()=>'',cliResult:async()=>({ok:true,body})});
    assert.equal((await bad()).ok,false);
  }
});
test("reconciliation treats only missing prose as absent and does not leak raw errors", async () => {
  for (const code of ['ENOENT','EACCES','EIO','EISDIR']) {
    const reconcile = extract(server,'reconcile',{settingsCatalog:async()=>({settings:[]}),cli:async()=>({variables:[]}),currentLibrary:()=>({libraryPath:'/fixture'}),scopeArguments:()=>[],PROSE_FILES:['AGENTS.md'],proseTarget:()=>'/fixture/AGENTS.md',readFile:async()=>{throw Object.assign(new Error('PRIVATE'),{code});},KEY_PATTERN:/\b(a.b)\b/gu});
    const result=await reconcile(); assert.equal(result.ok,code==='ENOENT'); assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  }
});
test("transport and JSON failures preserve unknown mutation outcome without retry",async()=>{
 for (const responseStub of [async()=>{throw new Error('private');},async()=>({json:async()=>{throw new Error('private');}})]) {
  let calls=0;
  const api=extract(browser,'api',{pageTarget:()=>({epoch:1}),state:{},BOOT:{token:'fixture'},headerJson:JSON.stringify,fetch:async(...args)=>{calls++;return responseStub(...args);},answered:(body)=>body});
  const result=await api('/api/variables',{method:'POST',body:'{}'}); assert.equal(result.outcome,'unknown'); assert.equal(result.retrySafe,false);assert.equal(calls,1);assert.ok(!JSON.stringify(result).includes('private'));
 }
});
test("rename pins both writes to original target and preserves partial commit receipt",async()=>{
 let epoch=1; const calls=[],receipts=[];
 const save=extract(browser,'saveVariable',{state:{variables:{variables:[]}},pageTarget:()=>({epoch,libraryId:'library:fixture'}),echo:()=>{},api:async(path,options)=>{calls.push(options);epoch=2;return calls.length===1?{ok:true,schemaVersion:'einzbern.variable-write-receipt.v1',reasonCode:'VARIABLE_WRITE_COMMITTED',persistence:'committed',workspaceId:'library:fixture',recordId:'new',variable:{name:'new'},version:1,headEventHash:'hash'}:{ok:false,reasonCode:'PORTAL_CONFIGURATION_TARGET_CHANGED'};},showReceipt:r=>receipts.push(r),refreshVariables:async()=>{},loadAgents:async()=>{},t:()=>''});
 await save({name:'new',type:'string',value:'value'},'old');assert.equal(calls.length,2);assert.deepEqual(calls.map(c=>c.target),[{epoch:1,libraryId:'library:fixture'},{epoch:1,libraryId:'library:fixture'}]);assert.equal(receipts[0].rename.partialCommit,true);
});
test("line selection includes preceding newline",()=>{
 const editor={value:'abc\nxyz',focus(){},setSelectionRange(a,b){this.range=[a,b];}};
 const focus=extract(browser,'focusLine',{$:()=>editor,lineFromText:text=>text.split('\n')});focus(2);assert.deepEqual(editor.range,[4,7]);focus(1);assert.deepEqual(editor.range,[0,3]);
});
test("knowledge renderer restores focus and error handler surrounds URL parsing",()=>{
 const renderer=declaration(browser,'renderKnowledgeView');assert.match(renderer,/rememberFocus/);assert.match(renderer,/restoreFocus/);
 const handler=server.slice(server.indexOf('const server = createServer'));assert.ok(handler.indexOf('try {')<handler.indexOf('new URL(request.url'));
});
test("knowledge search keeps keyboard focus across repeated input renderings", async()=>{
 const {parseHTML}=await import('linkedom');
 const {document,window}=parseHTML('<html><body><section data-page="dashboard"><span id="knowledge-count"></span><div id="knowledge-view-content"></div></section></body></html>');
 let active=null;Object.defineProperty(document,'activeElement',{get:()=>active});
 window.HTMLElement.prototype.focus=function(){active=this;};
 window.HTMLElement.prototype.setSelectionRange=function(start,end){this.selectionStart=start;this.selectionEnd=end;};
 const $=(selector,root=document)=>root.querySelector(selector), $$=(selector,root=document)=>[...root.querySelectorAll(selector)];
 const bindings={document,$,$$,focusableSelector:'input,select,textarea,button,[tabindex]'};
 const rememberFocus=extract(browser,'rememberFocus',bindings),restoreFocus=extract(browser,'restoreFocus',bindings);
 const state={knowledge:{ok:true,records:[]},knowledgeQuery:'',knowledgeStatus:'valid',knowledgeBody:null};
 const render=extract(browser,'renderKnowledgeView',{$,$$,state,rememberFocus,restoreFocus,setText:(selector,value)=>{$(selector).textContent=value;},t:key=>key,esc:value=>String(value??''),attachEcho:()=>{}});
 render();const original=$('#knowledge-filter');original.focus();original.selectionStart=1;original.selectionEnd=1;original.value='a';original.dispatchEvent(new window.Event('input'));
 assert.notEqual($('#knowledge-filter'),original);assert.equal(active,$('#knowledge-filter'));assert.equal(active.value,'a');assert.equal(active.selectionStart,1);
 active.value='ab';active.selectionStart=2;active.selectionEnd=2;active.dispatchEvent(new window.Event('input'));assert.equal(active,$('#knowledge-filter'));assert.equal(active.value,'ab');assert.equal(active.selectionStart,2);
});
test("Portal gate projection shares strict shape and nanosecond ordering with engine",async()=>{
 const {isGateRunRecord,compareGateRuns}=await import('../../scripts/lib/gate-run.mjs');
 const admit=extract(server,'isGateRun',{isGateRunRecord});
 const libraryId='library:'+'a'.repeat(24);
 const run={schemaVersion:'einzbern.gate-run.v1',libraryId,runId:'z-old',at:'2026-10-18T00:00:00.000000001Z',release:false,base:null,workIds:[],treeDigest:'tree',declarationsDigest:'declarations',trees:[],gates:[],reds:[]};
 assert.equal(admit(run,libraryId,null),true);
 for(const key of ['release','base','workIds','trees']) {const bad={...run};delete bad[key];assert.equal(admit(bad,libraryId,null),false,key);}
 const gate={name:'gate',ok:true,required:true,root:'.',exitCode:0,signal:null,timedOut:false,outputFile:'fixture.log',outputBytes:0,truncated:false,matched:[],matchedWorkIds:[]};
 assert.equal(admit({...run,gates:[gate]},libraryId,null),true);
 for(const key of ['root','exitCode']) {const bad={...gate};delete bad[key];assert.equal(admit({...run,gates:[bad]},libraryId,null),false,key);}
 const newer={...run,runId:'a-new',at:'2026-10-18T00:00:00.000000002Z'};assert.ok(compareGateRuns(newer,run)<0);
 const project=extract(server,'latestGateRunProjection',{currentLibrary:()=>({libraryId,configurationProjectId:null}),deviceHomePath:()=>'/fixture',join:(...parts)=>parts.join('/'),readdir:async()=>['old.json','new.json','bad.json'].map(name=>({name,isFile:()=>true})),readFile:async path=>JSON.stringify(path.endsWith('new.json')?newer:path.endsWith('old.json')?run:{...newer,release:undefined}),isGateRun:admit,compareGateRuns});
 assert.equal((await project()).run.runId,'a-new');
});

test("rename does not delete old name after an unknown create outcome",async()=>{
 const calls=[],receipts=[];
 const save=extract(browser,'saveVariable',{state:{variables:{variables:[]}},pageTarget:()=>({epoch:1}),echo:()=>{},api:async(path,options)=>{calls.push(options);return {ok:false,outcome:'unknown'};},showReceipt:r=>receipts.push(r),refreshVariables:async()=>assert.fail('no confirmed commit'),loadAgents:async()=>assert.fail('no confirmed commit'),t:()=>''});
 await save({name:'new',type:'string',value:'value'},'old');assert.equal(calls.length,1);assert.equal(receipts[0].outcome,'unknown');
});
test("translation proof includes literals missing in every locale, not dynamic templates",async()=>{
 const proof=await readFile(new URL('../scripts/i18n-proof.mjs',import.meta.url),'utf8');
 const consumerSource=`<div data-i18n="missing.everywhere"></div><div data-i18n="\${esc(key)}"></div> t("also.missing")`;
 const refs=new Function('consumerSource',`${declaration(proof,'referencedKeys')};return referencedKeys;`)(consumerSource);
 assert.deepEqual(refs.sort(),['also.missing','missing.everywhere']);
});

test("rename refuses malformed or unbound success envelopes before deletion",async()=>{
 for(const answer of [{},{ok:true},{ok:true,mutation:{}},{ok:true,persistence:'committed',variable:{name:'new'}}]) {
  const calls=[],receipts=[];
  const save=extract(browser,'saveVariable',{state:{variables:{variables:[]}},pageTarget:()=>({epoch:1,libraryId:'library:fixture'}),echo:()=>{},api:async(path,options)=>{calls.push(options);return answer;},showReceipt:r=>receipts.push(r),refreshVariables:async()=>assert.fail('no confirmed commit'),loadAgents:async()=>assert.fail('no confirmed commit'),t:()=>''});
  await save({name:'new',type:'string',value:'value'},'old');assert.equal(calls.length,1);assert.equal(receipts[0].outcome,'unknown');
 }
});
test("knowledge store disappearance after a page is not a green prefix",async()=>{
 let calls=0;
 const project=extract(server,'knowledgeProjection',{currentLibrary:()=>({libraryPath:'/fixture'}),readInstant:()=>'',cliResult:async()=>++calls===1?{ok:true,body:{total:2,records:[{id:'first'}]}}:{ok:true,body:{knowledgeStore:'absent',records:[],total:0}}});
 const result=await project();assert.equal(result.ok,false);assert.deepEqual(result.records,[]);assert.equal(calls,2);
});

test("GET transport failures reach existing reader catch handlers with sanitized diagnostics", async()=>{
 for (const responseStub of [async()=>{throw new Error('PRIVATE URL');},async()=>({json:async()=>{throw new Error('PRIVATE BODY');}})]) {
  let calls=0;
  const api=extract(browser,'api',{pageTarget:()=>({epoch:1}),state:{},BOOT:{token:'fixture'},headerJson:JSON.stringify,fetch:async(...args)=>{calls++;return responseStub(...args);},answered:(body)=>body});
  await assert.rejects(()=>api('/api/work'), error=>error.message==='Unable to read the response.');
  assert.equal(calls,1);
 }
});
