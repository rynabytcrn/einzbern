// SPDX-License-Identifier: Apache-2.0
// INC-399 Owner R1–R6: scratch-only public writes, full replay, large positive inputs,
// stable target bindings and unchanged refusal/user-modification protections.
import './helpers/device-home.mjs';
import { standInForAtelier, workspaceFixture } from './helpers/workspace-fixture.mjs';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { runCli } from '../dist/build/packages/cli/src/index.js';
import { canonicalJson, canonicalSha256, assertProtocolId } from '../dist/build/packages/protocol/src/index.js';
import { materializeWorkspace, materializeWorkspaceFromGenesis, createProject, updateProject, deleteProject, createWork, setWorkspaceSetting, removeWorkspaceSetting, exportWorkspace } from '../dist/build/packages/core/src/workspace.js';
import { scopedWorkspaceState, designConfiguration } from '../dist/build/packages/core/src/project-scope.js';
import { setConfigRecord, configRecord } from '../dist/build/packages/core/src/config-records.js';
import { builtInRule, BUILT_IN_RULE_IDS, ruleBody } from '../dist/build/packages/core/src/rules-catalog.js';
import { enableRule, listRules } from '../dist/build/packages/core/src/rules.js';
import { renderAgentsSections } from '../dist/build/packages/core/src/agents-sections.js';
import { parseDecisionAddress } from '../dist/build/packages/core/src/minutes.js';
import { workParentChain } from '../dist/build/packages/core/src/recall-inputs.js';
import { RecallIndex, recallQueryTokens, selectRecallHits } from '../dist/build/packages/core/src/recall.js';
import { registerLibrary } from '../dist/build/packages/core/src/registry.js';
import { initializeKnowledgeStore, createKnowledgeArticle, captureKnowledgeUnit, listKnowledgeMetadata, readKnowledgeBody, checkKnowledgeSources } from '../dist/build/packages/core/src/knowledge-core.js';
import { renameRetryBudget } from '../dist/build/packages/core/src/io-policy.js';
import { ensureSetupProjectBinding, setupTargetState, scopeSetupTargetState, libraryLanguage } from '../dist/build/packages/core/src/setup-fresh.js';
import { localProbeTimeout } from '../dist/build/packages/core/src/io-policy.js';
import { RUNTIME_CAPACITY } from '../scripts/lib/runtime-capacity.mjs';
import { constants as bufferConstants } from 'node:buffer';
import { writeUstar, readUstar } from '../scripts/lib/tar.mjs';
standInForAtelier();
let second=0;
const at=()=>new Date(Date.UTC(2026,9,3,4,0,++second)).toISOString();
async function cli(args) { let out='';await runCli(args,{write:v=>{out+=v;}});return JSON.parse(out); }
const value=(view,key)=>view.settings.find(s=>s.key===key)?.value ?? null;

test('R1: setup defines explicit new targets, reuses declared identities and never adopts a sole existing work project',async ctx=>{
 const {workspace,projectId:p,base}=await workspaceFixture(ctx,{externalKey:'R27-SETUP-SCOPE'});
 const one=join(base,'one'),two=join(base,'two');await mkdir(one);await mkdir(two);
 const deviceHome=process.env.EINZBERN_HOME;
 const a=await ensureSetupProjectBinding(one,workspace,{at:at(),deviceHome});
 const b=await ensureSetupProjectBinding(two,workspace,{at:at(),deviceHome});
 assert.notEqual(a,p);assert.notEqual(a,b);
 await registerLibrary({projectPath:one,libraryPath:workspace,projectId:a,registeredAt:at()},deviceHome);
 assert.equal(await ensureSetupProjectBinding(one,workspace,{at:at(),deviceHome}),a);
 await setWorkspaceSetting(workspace,{key:'artifact.language',value:'fr',configurationProjectId:a,occurredAt:at()});
 await setWorkspaceSetting(workspace,{key:'artifact.language',value:'ja',configurationProjectId:b,occurredAt:at()});
 const state=await materializeWorkspaceFromGenesis(workspace);
 assert.equal(value(scopedWorkspaceState(state,a),'artifact.language'),'fr');assert.equal(value(scopedWorkspaceState(state,b),'artifact.language'),'ja');
 assert.equal(value(scopedWorkspaceState(state,p),'artifact.language'),null);
});

test('R1/F01: setup planning scopes retained state by explicit binding and refuses conflicting library identity',async ctx=>{
 const {workspace,projectId:p,base}=await workspaceFixture(ctx,{externalKey:'R31-SETUP-READ'});
 const project=join(base,'declared'),unregistered=join(base,'unregistered');await mkdir(project);await mkdir(unregistered);
 let state=await createProject(workspace,{externalKey:'R31-SETUP-CHILD',name:'Child',parentProjectId:p,occurredAt:at()});
 const c=state.projects.find(x=>x.externalKey==='R31-SETUP-CHILD').id;
 await setWorkspaceSetting(workspace,{key:'artifact.language',value:'fr',configurationProjectId:p,occurredAt:at()});
 await registerLibrary({projectPath:project,libraryPath:workspace,projectId:c,registeredAt:at()},process.env.EINZBERN_HOME);
 state=await materializeWorkspaceFromGenesis(workspace);
 const inherited=await scopeSetupTargetState(project,workspace,process.env.EINZBERN_HOME,state);
 assert.equal(libraryLanguage(inherited),'fr');assert.equal(inherited.settingSources['artifact.language'].projectId,p);
 assert.equal(libraryLanguage(await setupTargetState(project,workspace,process.env.EINZBERN_HOME)),'fr');
 assert.equal(libraryLanguage(await scopeSetupTargetState(unregistered,join(unregistered,'.ether'),process.env.EINZBERN_HOME,state)),null,'an absent target never adopts the only project or another project language');
 await assert.rejects(scopeSetupTargetState(project,join(project,'.ether'),process.env.EINZBERN_HOME,state),{reasonCode:'SETUP_LIBRARY_CONFLICT'});
 await assert.rejects(scopeSetupTargetState(project,workspace,process.env.EINZBERN_HOME,{...state,metadata:{...state.metadata,workspaceId:'workspace:000000000000000000000000'}}),{reasonCode:'SETUP_LIBRARY_CONFLICT'});
 await setWorkspaceSetting(workspace,{key:'artifact.language',value:'ja',configurationProjectId:c,occurredAt:at()});
 assert.equal(libraryLanguage(await setupTargetState(project,workspace,process.env.EINZBERN_HOME)),'ja');
});

test('R4: retained runtime and format capacities have actual failure evidence; scheduling budgets are caller choices',()=>{
 assert.equal(RUNTIME_CAPACITY.bufferBytes,bufferConstants.MAX_LENGTH);assert.equal(RUNTIME_CAPACITY.stringCodeUnits,bufferConstants.MAX_STRING_LENGTH);
 assert.throws(()=>Buffer.alloc(RUNTIME_CAPACITY.bufferBytes+1),RangeError);
 assert.throws(()=>'x'.repeat(RUNTIME_CAPACITY.stringCodeUnits+1),RangeError);
 assert.throws(()=>new Array(RUNTIME_CAPACITY.arrayEntries+1),RangeError);
 assert.equal(Number.MAX_SAFE_INTEGER+1,Number.MAX_SAFE_INTEGER+2,'distinct counters alias beyond the safe integer range');
 const path='a'.repeat(100);const archive=writeUstar([{path,bytes:Buffer.from('complete')}]);assert.equal(readUstar(archive)[0].path,path);
 assert.throws(()=>writeUstar([{path:path+'a',bytes:Buffer.from('complete')}]),error=>error.reasonCode==='TAR_PATH_TOO_LONG');
 const previous=process.env.EINZBERN_LOCAL_PROBE_TIMEOUT_MS;try{process.env.EINZBERN_LOCAL_PROBE_TIMEOUT_MS='240000';assert.equal(localProbeTimeout(),240000);process.env.EINZBERN_LOCAL_PROBE_TIMEOUT_MS=String(RUNTIME_CAPACITY.timerMilliseconds+1);assert.throws(()=>localProbeTimeout(),/timer range/);}finally{if(previous===undefined)delete process.env.EINZBERN_LOCAL_PROBE_TIMEOUT_MS;else process.env.EINZBERN_LOCAL_PROBE_TIMEOUT_MS=previous;}
});

test('R1: stable projects and declared subprojects persist distinct writes, inherited source, reset and rename across replay/export',async ctx=>{
 const {workspace,projectId:p,base}=await workspaceFixture(ctx,{externalKey:'R27-SCOPES'});
 let s=await createProject(workspace,{externalKey:'R27-CHILD',name:'Subproject',parentProjectId:p,occurredAt:at()});
 const c=s.projects.find(x=>x.externalKey==='R27-CHILD').id;
 s=await createProject(workspace,{externalKey:'R27-PEER',name:'Peer',occurredAt:at()});const peer=s.projects.find(x=>x.externalKey==='R27-PEER').id;
 await setWorkspaceSetting(workspace,{key:'retrieval.tau',value:'201',occurredAt:at()});
 await setWorkspaceSetting(workspace,{key:'retrieval.tau',value:'202',configurationProjectId:p,occurredAt:at()});
 await setWorkspaceSetting(workspace,{key:'retrieval.tau',value:'203',configurationProjectId:c,occurredAt:at()});
 await setWorkspaceSetting(workspace,{key:'retrieval.tau',value:'204',configurationProjectId:peer,occurredAt:at()});
 const variable={type:'string',value:'parent content',description:'An inherited variable'};
 await setConfigRecord(workspace,{collection:'variable',key:'banner',value:variable,projectId:p,occurredAt:at()});
 await setConfigRecord(workspace,{collection:'variable',key:'banner',value:{...variable,value:'child content'},projectId:c,occurredAt:at()});
 await setConfigRecord(workspace,{collection:'gate',key:'only-parent',value:{command:['node','--version'],root:'.',covers:[],required:true,enabled:true,releaseOnly:false},projectId:p,occurredAt:at()});
 s=await materializeWorkspaceFromGenesis(workspace);
 assert.deepEqual([undefined,p,c,peer].map(id=>value(scopedWorkspaceState(s,id),'retrieval.tau')),['201','202','203','204']);
 assert.equal(configRecord(scopedWorkspaceState(s,c),'variable','banner').value.value,'child content');
 assert.equal(configRecord(scopedWorkspaceState(s,c),'gate','only-parent'),null,'roots/coverage never inherit from another target');
 await removeWorkspaceSetting(workspace,{key:'retrieval.tau',configurationProjectId:c,occurredAt:at()});
 await cli(['variable-remove','--workspace',workspace,'--project-id',c,'--name','banner','--at',at()]);
 s=await materializeWorkspace(workspace);let child=scopedWorkspaceState(s,c);
 assert.equal(value(child,'retrieval.tau'),'202');assert.equal(child.settingSources['retrieval.tau'].projectId,p);assert.equal(child.settingSources['retrieval.tau'].inherited,true);
 assert.equal(configRecord(child,'variable','banner').value.value,'parent content');
 await updateProject(workspace,{id:p,name:'Renamed parent',occurredAt:at()});
 child=scopedWorkspaceState(await materializeWorkspace(workspace),c);assert.equal(child.settingSources['retrieval.tau'].projectName,'Renamed parent');
 const read=await cli(['settings-catalog','--workspace',workspace,'--project-id',c]);
 assert.equal(read.projectId,c);let row=read.settings.find(x=>x.key==='retrieval.tau');assert.equal(row.currentValue,'202');assert.equal(row.declaredValue,null);assert.equal(row.source.projectId,p);
 await assert.rejects(()=>setWorkspaceSetting(workspace,{key:'storage.segmentBytes',value:'100000000',configurationProjectId:c,occurredAt:at()}),/whole library/);
 await assert.rejects(()=>setWorkspaceSetting(workspace,{key:'retrieval.tau',value:'1',configurationProjectId:'project:'+'f'.repeat(24),occurredAt:at()}),/absent or deleted/);
 await assert.rejects(()=>deleteProject(workspace,{id:p,occurredAt:at()}),/subprojects/);
 const exported=JSON.parse(await exportWorkspace(workspace));
 assert.ok(canonicalJson(exported).includes(c));assert.ok(canonicalJson(exported).includes('parentProjectId'));
 const project=join(base,'unbound-project');await mkdir(project);await writeFile(join(project,'AGENTS.md'),'# Keep me\n');
 await registerLibrary({projectPath:project,libraryPath:workspace,registeredAt:at()});
 await assert.rejects(()=>cli(['agents-render','--project',project,'--at',at()]),/no stable project binding/);
 assert.equal(await readFile(join(project,'AGENTS.md'),'utf8'),'# Keep me\n');
 await registerLibrary({projectPath:project,libraryPath:workspace,projectId:c,registeredAt:at()});
 const receipt=await cli(['agents-render','--project',project,'--at',at()]);assert.equal(receipt.reasonCode,'AGENTS_RENDERED');
 const text=await readFile(join(project,'AGENTS.md'),'utf8');assert.ok(text.includes(c));assert.ok(text.includes('parent content'));
 await assert.rejects(()=>cli(['agents-render','--project',project,'--project-id',peer,'--at',at()]),/binding|conflict/);
});

test('R1/R6: companion bindings show inherited sources, local consumed version, missing/conflicting state and no publication claim',async ctx=>{
 const {workspace,projectId:p}=await workspaceFixture(ctx,{externalKey:'R27-DESIGN'});
 let s=await createProject(workspace,{externalKey:'R27-DESIGN-CHILD',name:'Child',parentProjectId:p,occurredAt:at()});let c=s.projects.find(x=>x.externalKey==='R27-DESIGN-CHILD').id;
 assert.equal(designConfiguration(scopedWorkspaceState(s,c)).status,'unconfigured');
 const entries={'design.authority':'https://authority.example/contract.json','design.repository':'https://authority.example/repository','design.pullRequestTarget':'main','design.productionDocs':'https://authority.example/docs','design.buildService':'Declared build service','design.buildProject':'Authority docs','design.consumedVersion':'release-v1'};
 for(const [key,v] of Object.entries(entries))await setWorkspaceSetting(workspace,{key,value:v,configurationProjectId:p,occurredAt:at()});
 s=await setWorkspaceSetting(workspace,{key:'design.consumedVersion',value:'release-v2',configurationProjectId:c,occurredAt:at()});
 let d=designConfiguration(scopedWorkspaceState(s,c));assert.equal(d.status,'declared');assert.equal(d.publicationVerification,'unverified');assert.equal(d.bindings.find(x=>x.key==='design.repository').source.projectId,p);assert.equal(d.bindings.find(x=>x.key==='design.consumedVersion').source.projectId,c);
 s=await setWorkspaceSetting(workspace,{key:'design.authority',value:'https://other.example/contract.json',configurationProjectId:c,occurredAt:at()});
 assert.equal(designConfiguration(scopedWorkspaceState(s,c)).status,'conflicting');
});

test('R1/R4: project article consumers use their own folders and stable identities; full cards survive former text, tag and evidence ceilings',async ctx=>{
 const {workspace,projectId:p}=await workspaceFixture(ctx,{externalKey:'R27-ARTICLE'});
 await initializeKnowledgeStore(workspace,{disposableAcknowledged:true});
 let state=await createProject(workspace,{externalKey:'R27-ARTICLE-PEER',name:'Peer articles',occurredAt:at()});
 const peer=state.projects.find(x=>x.externalKey==='R27-ARTICLE-PEER').id;
 for(const [projectId,path] of [[p,'articles/one'],[peer,'articles/two']])await setWorkspaceSetting(workspace,{key:'knowledge.articlesPath',value:path,configurationProjectId:projectId,occurredAt:at()});
 const common={path:'same.md',category:'architecture',title:'Article '+ 't'.repeat(600),summary:'summary '.repeat(400),accountableOwnerId:'owner:r27-article',linkedEvidenceIds:['evidence:r27-article']};
 const a=await createKnowledgeArticle(workspace,{...common,projectId:p,content:'one full article',occurredAt:at()});
 const b=await createKnowledgeArticle(workspace,{...common,title:'Peer deployment agreement',summary:'An independent second project deployment decision',projectId:peer,content:'two full article',occurredAt:at()});
 assert.notEqual(a.id,b.id);assert.ok((await readFile(join(workspace,'articles/one/same.md'),'utf8')).endsWith('one full article'));assert.ok((await readFile(join(workspace,'articles/two/same.md'),'utf8')).endsWith('two full article'));
 const sources=await checkKnowledgeSources(workspace);assert.equal(sources.records.filter(x=>[a.id,b.id].includes(x.id)).every(x=>x.status==='unchanged'),true);
 const body='complete long lesson '.repeat(65000);
 const card=await captureKnowledgeUnit(workspace,{scope:'project',projectId:p,occurredAt:at(),externalKey:'R27-LESSON-'+ 'L'.repeat(200),subject:'Subject '+ 's'.repeat(600),summary:'Summary '+ 'm'.repeat(2400),snippet:'Snippet '+ 'n'.repeat(700),tags:Array.from({length:40},(_,i)=>'tag'+String(i).padStart(3,'0')),accountableOwnerId:'owner:r27-card',linkedEvidenceIds:Array.from({length:70},(_,i)=>'evidence:proof'+String(i).padStart(3,'0')),body});
 assert.equal((await readKnowledgeBody(workspace,card.id,{at:at()})).body,body);
 const listing=await listKnowledgeMetadata(workspace,{at:at(),projectId:p,selection:'all'});const metadata=listing.records.find(x=>x.id===card.id);
 assert.equal(metadata.projectId,p);assert.equal(metadata.tags.length,40);assert.equal(metadata.linkedEvidenceIds.length,70);assert.ok(metadata.subject.length>512);assert.ok(metadata.summary.length>2048);assert.ok(metadata.snippet.length>512);
 const previous=process.env.EINZBERN_RENAME_RETRY_BUDGET;try{process.env.EINZBERN_RENAME_RETRY_BUDGET='19';assert.equal(renameRetryBudget(),19);assert.equal(renameRetryBudget(21),21);process.env.EINZBERN_RENAME_RETRY_BUDGET='-1';assert.throws(()=>renameRetryBudget(),/INVALID/);}finally{if(previous===undefined)delete process.env.EINZBERN_RENAME_RETRY_BUDGET;else process.env.EINZBERN_RENAME_RETRY_BUDGET=previous;}
});

test('R6: exact generic v1 ZH/EN bodies, five presets, explicit update, user edits preserved',async ctx=>{
 const {workspace,projectId:p,base}=await workspaceFixture(ctx,{externalKey:'R27-PRESET'});const root=join(base,'project');await mkdir(root);await writeFile(join(root,'AGENTS.md'),'# Local notes\n');
 assert.deepEqual(BUILT_IN_RULE_IDS,['autonomy','batch','unattended-commands','silent-reporting','design-authority']);
 const rule=builtInRule('design-authority');assert.equal(rule.version,1);
 for(const lang of ['zh','en'])assert.equal(rule.body[lang],await readFile(new URL('fixtures/rules/design-authority.'+lang+'.md',import.meta.url),'utf8'));
 assert.equal(ruleBody('design-authority','zh-CN'),rule.body.zh);assert.equal(ruleBody('design-authority','fr'),rule.body.en);
 assert.ok(!/https?:\/\//u.test(rule.body.en));
 await enableRule({libraryRoot:workspace,projectRoot:root,configurationProjectId:p,id:'design-authority',occurredAt:at()});
 let text=await readFile(join(root,'AGENTS.md'),'utf8');assert.ok(text.includes('Design Authority and Consistency Principle v1'));
 const newer=[...((await import('../dist/build/packages/core/src/rules-catalog.js')).BUILT_IN_RULES)].map(x=>x.id===rule.id?{...x,version:2,body:{en:x.body.en+'\nRevision two.\n',zh:x.body.zh+'\n第二版。\n'}}:x);
 assert.equal((await listRules({libraryRoot:workspace,projectRoot:root,configurationProjectId:p,catalog:newer})).find(x=>x.id===rule.id).state,'update-available');
 assert.equal(await readFile(join(root,'AGENTS.md'),'utf8'),text,'reading a newer catalog never auto-upgrades');
 await enableRule({libraryRoot:workspace,projectRoot:root,configurationProjectId:p,id:rule.id,catalog:newer,occurredAt:at()});
 text=await readFile(join(root,'AGENTS.md'),'utf8');assert.ok(text.includes('Revision two.'));
 const edited=text.replace('Revision two.','Owner changed this section.');await writeFile(join(root,'AGENTS.md'),edited);
 await renderAgentsSections(workspace,{projectRoot:root,configurationProjectId:p,occurredAt:at()});
 assert.ok((await readFile(join(root,'AGENTS.md'),'utf8')).includes('Owner changed this section.'));
 assert.ok(['user-modified','pending'].includes((await listRules({libraryRoot:workspace,projectRoot:root,configurationProjectId:p,catalog:newer})).find(x=>x.id===rule.id).state));
});

test('R4: V1 bytes, complete deep values, large arrays/objects, explicit invalid-value refusals',()=>{
 assert.equal(canonicalJson({z:[null,true,'雪'],a:{b:2,a:1}}),'{"a":{"a":1,"b":2},"z":[null,true,"雪"]}\n');
 let deep='end';for(let i=0;i<12000;i++)deep={next:deep};const serialized=canonicalJson(deep);assert.equal(serialized.length,12000*9+6);assert.equal(canonicalSha256(deep).length,64);
 assert.equal(JSON.parse(canonicalJson(Array.from({length:25001},(_,i)=>i))).length,25001);
 const object=Object.fromEntries(Array.from({length:9001},(_,i)=>['field-'+String(i).padStart(5,'0'),'content']));assert.equal(Object.keys(JSON.parse(canonicalJson(object))).length,9001);
 const big='雪'.repeat(400000);assert.ok(Buffer.byteLength(canonicalJson(big))>1048576);assert.equal(JSON.parse(canonicalJson(big)),big);
 const cycle={};cycle.self=cycle;assert.throws(()=>canonicalJson(cycle),/cycle/);assert.throws(()=>canonicalJson('\ud800'),/Unicode|surrogate|well-formed/);assert.throws(()=>canonicalJson(Number.MAX_SAFE_INTEGER+1),/safe integer/);assert.throws(()=>canonicalJson(new Date()),/plain JSON/);
 assertProtocolId('record:'+'x'.repeat(400));assert.equal(parseDecisionAddress('minutes:'+'a'.repeat(24)+'#D10000').number,10000);assert.equal(parseDecisionAddress('minutes:'+'a'.repeat(24)+'#D9007199254740992'),null);
});

test('R4: large settings/custom value, actual event replay/export, full query candidates pass former ceilings',async ctx=>{
 const {workspace,projectId:p}=await workspaceFixture(ctx,{externalKey:'R27-CAPACITY'});
 for(const [key,v] of Object.entries({'execution.maxConcurrentSubagents':'33','injection.perPromptBytes':'20000','storage.segmentBytes':'100000000','storage.snapshotEveryEvents':'25001','retrieval.scopeExcerptBytes':'100000','retrieval.tau':'201','models.escalation.threshold':'101'}))await setWorkspaceSetting(workspace,{key,value:v,occurredAt:at()});
 const large='Large完整內容'.repeat(130000);
 await setConfigRecord(workspace,{collection:'variable',key:'large-custom-value',projectId:p,value:{type:'string',value:large,description:'Full content'},occurredAt:at()});
 await createWork(workspace,{externalKey:'R27-LARGE-'+ 'A'.repeat(220),projectId:p,parentId:null,kind:'Initiative',scope:large,summary:'summary '.repeat(1000),occurredAt:at()});
 const replay=await materializeWorkspaceFromGenesis(workspace);assert.equal(configRecord(scopedWorkspaceState(replay,p),'variable','large-custom-value').value.value,large);
 const exported=await exportWorkspace(workspace);assert.ok(Buffer.byteLength(exported)>1048576);assert.ok(JSON.parse(exported).work[0].extensions['advisory:scope'].value===large);
 await assert.rejects(()=>setWorkspaceSetting(workspace,{key:'retrieval.tau',value:'9007199254740992',occurredAt:at()}));
 const docs=Array.from({length:120},(_,i)=>({id:'card-'+i,kind:'card',key:'CARD-'+i,status:'active',title:'uncommonterm completeanswer',body:'uncommonterm completeanswer',tags:'',expansions:'',summary:'complete',recordKind:'card',parentChain:[],lead:''}));
 const idx=new RecallIndex(docs,'test');try{const hits=idx.search('uncommonterm');assert.equal(hits.length,120);assert.equal(selectRecallHits(hits,{limit:120,tau:0,relativeFloor:0}).length,120);}finally{idx.close();}
 const prompt=Array.from({length:100},(_,i)=>'uniqueterm'+i).join(' ');assert.ok(recallQueryTokens(prompt).length>24);
 const work=new Map(Array.from({length:25},(_,i)=>['w'+i,{id:'w'+i,parentId:i===24?null:'w'+(i+1),title:'Title '+i,externalKey:'K'+i}]));assert.equal(workParentChain(work,work.get('w0')).length,24);
});
