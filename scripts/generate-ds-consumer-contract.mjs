#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// INC-399: one explicit, offline generation from already verified Production evidence.
// Runtime consumes the local snapshots; it never reads a Design System checkout.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { repositoryRoot } from "./lib/files.mjs";
const argv=process.argv.slice(2);
const options=Object.fromEntries(Array.from({length:argv.length/2},(_,i)=>[argv[i*2],argv[i*2+1]]));
if(argv.length!==4 || new Set([argv[0],argv[2]]).size!==2 || Object.keys(options).some(key=>!["--publication-evidence","--static-bridge-source"].includes(key)) || !options["--publication-evidence"] || !options["--static-bridge-source"])throw new Error("DS_CONSUMER_GENERATION_ARGUMENTS_INVALID");
const proofPath=resolve(options["--publication-evidence"]);
const proof=JSON.parse(await readFile(proofPath,"utf8"));
const sha=value=>createHash("sha256").update(value).digest("hex");
if(proof.dependencySatisfied!==true || proof.environment!=="Production" || proof.authority?.sourceCommit!==proof.mergeCommit || !/^[a-f0-9]{40}$/u.test(proof.mergeCommit) || !proof.deploymentStatusId || !proof.vercelBuildStatusId)throw new Error("DS_PRODUCTION_DEPENDENCY_UNSATISFIED");
const bridge=await readFile(resolve(options["--static-bridge-source"]));
// TCRN-CROSS-INIT-053 R46 S19 (I20/I23): the public exports are the bridge's own, read from its one
// export clause and sorted by name; a bridge without either binding the page imports is refused
// before anything is written.
const bridgeIdentifier=String.raw`[\p{ID_Start}$_][\p{ID_Continue}$\u200c\u200d]*`;
const bridgeClauses=[...bridge.toString("utf8").matchAll(/export\s*\{([^{}]*)\}\s*;?/gu)];
const bridgeEntry=new RegExp(`^(${bridgeIdentifier})(?:\\s+as\\s+(${bridgeIdentifier}))?$`,"u");
const publicExports=bridgeClauses.length!==1?[]:bridgeClauses[0][1].split(",").map(part=>part.trim()).filter(part=>part!=="").map(part=>{const match=bridgeEntry.exec(part);return match?match[2]??match[1]:null;});
if(publicExports.length===0 || publicExports.includes(null) || new Set(publicExports).size!==publicExports.length || !["mountStaticMultiSelect","mountStaticOverlayBoundary"].every(name=>publicExports.includes(name)))throw new Error("DS_STATIC_BRIDGE_EXPORTS_INVALID");
publicExports.sort();
const css=await readFile(resolve(repositoryRoot,"portal/ds-component-css.snapshot.css"));
const tokens=await readFile(resolve(repositoryRoot,"portal/tokens.css"));
if(sha(bridge)!==proof.authority.staticBridgeDigest || sha(css)!==proof.authority.componentCssDigest || sha(tokens)!==proof.authority.tokensDigest)throw new Error("DS_PUBLISHED_ASSET_DIGEST_MISMATCH");
const aiEvidence=proof.artifacts?.find(item=>item.artifact==="ai-consumption-contract.json");
if(!aiEvidence || basename(aiEvidence.file)!==aiEvidence.file)throw new Error("DS_PUBLISHED_CONTRACT_EVIDENCE_MISSING");
const aiBytes=await readFile(resolve(dirname(proofPath),aiEvidence.file));
if(sha(aiBytes)!==aiEvidence.sha256 || aiBytes.length!==aiEvidence.bytes)throw new Error("DS_PUBLISHED_CONTRACT_EVIDENCE_MISMATCH");
const publishedAI=JSON.parse(aiBytes.toString("utf8"));
const {contractPayloadDigest,...publishedPayload}=publishedAI;
if(sha(JSON.stringify(publishedPayload,null,2)+"\n")!==contractPayloadDigest)throw new Error("DS_PUBLISHED_CONTRACT_PAYLOAD_MISMATCH");
if(publishedAI.contractPayloadDigest!==proof.aiContractPayloadDigest || !/^[a-f0-9]{64}$/u.test(publishedAI.brandAssetSource?.sha256 ?? ""))throw new Error("DS_PUBLISHED_CONTRACT_BINDING_MISMATCH");
const brand=await readFile(resolve(repositoryRoot,"portal/atelier-brand-mark.svg"));
if(sha(brand)!==publishedAI.brandAssetSource.sha256)throw new Error("DS_PUBLISHED_BRAND_DIGEST_MISMATCH");
const path=resolve(repositoryRoot,"portal/ds-consumer-contract.json");
const contract=JSON.parse(await readFile(path,"utf8"));
contract.candidate=proof.mergeCommit;
contract.candidateTree=proof.mergeTree;
if(!/^[a-f0-9]{40}$/u.test(contract.candidateTree))throw new Error("DS_MERGE_TREE_IDENTITY_MISSING");
contract.package="@tcrn/ui-react@"+proof.authority.version;
contract.aiContract.payloadDigest=proof.aiContractPayloadDigest;
contract.componentCss.bytes=css.length;contract.componentCss.sha256=sha(css);
contract.tokensCss={snapshot:"portal/tokens.css",bytes:tokens.length,sha256:sha(tokens)};
contract.brandAsset={snapshot:"portal/atelier-brand-mark.svg",bytes:brand.length,sha256:sha(brand),publishedSource:publishedAI.brandAssetSource.url};
contract.staticBridge={snapshot:"portal/ds-static-bridges.snapshot.js",bytes:bridge.length,sha256:sha(bridge),publicExports};
contract.production={sourceCommit:proof.mergeCommit,environment:proof.environment,documentationOrigin:proof.productionOrigin,deploymentId:proof.deploymentId,deploymentStatusId:proof.deploymentStatusId,buildStatusId:proof.vercelBuildStatusId,buildUrl:proof.vercelBuildURL};
contract.consumedContracts.multiSelect={presentation:"dropdown",family:"Select/Menu",publicBridge:"mountStaticMultiSelect",valueBridge:"native multiple select",selectionRole:"listbox/option",draftActions:["Save","Undo","Reset"],compatibilityPresentations:["native","checkboxes"]};
contract.reconciliation.status="production-published-consumed";
contract.boundaries.packagePublication="Production documentation/static contract verified; package registry publication not claimed";
await writeFile(resolve(repositoryRoot,contract.staticBridge.snapshot),bridge);
await writeFile(path,JSON.stringify(contract,null,2)+"\n");
let index=await readFile(resolve(repositoryRoot,"portal/index.html"),"utf8");
const attributes={"data-ds-candidate":"TCRN-Design-System@"+contract.candidate,"data-ds-candidate-sha":contract.candidate,"data-ds-overlay-candidate":"TCRN-Design-System@"+contract.candidate,"data-ds-consumer-status":contract.reconciliation.status,"data-ds-contract-status":contract.reconciliation.status,"data-ds-candidate-status":contract.reconciliation.status,"data-ds-mapping-status":contract.reconciliation.status,"data-ds-ai-contract-digest":contract.aiContract.payloadDigest,"data-ds-contract-digest":contract.aiContract.payloadDigest,"data-ds-component-css-digest":contract.componentCss.sha256,"data-ds-component-css-sha256":contract.componentCss.sha256};
for(const [name,value] of Object.entries(attributes))index=index.replace(new RegExp(name+'="[^"\\n]+"','gu'),name+'="'+value+'"');
await writeFile(resolve(repositoryRoot,"portal/index.html"),index);
process.stdout.write(JSON.stringify({ok:true,reasonCode:"DS_PUBLISHED_CONSUMER_GENERATED",sourceCommit:proof.mergeCommit,componentCss:contract.componentCss,staticBridge:contract.staticBridge})+"\n");
