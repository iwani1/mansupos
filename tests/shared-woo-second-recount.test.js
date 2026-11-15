import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assessSharedWooInventoryCutover } from '../server/shared-woo-cutover-readiness.js';
import { renderSharedWooCutoverReadiness } from '../scripts/assess-shared-woo-cutover.mjs';
import { loadInStoreSnapshot } from '../server/instore-catalog.js';

const sourceHash='a'.repeat(64),wooHash='b'.repeat(64),evidenceHash='c'.repeat(64);
const at='2026-11-15T17:00:00.000Z',now=Date.parse('2026-11-15T17:30:00.000Z');
const physical=()=>({manifestHash:sourceHash,items:[
  {sku:'1001',name:'SECRET DRESS',status:'available',reportedQuantity:3},
  {sku:'1002',name:'SECRET SIZE L',status:'out_of_stock',reportedQuantity:0},
  {sku:'1003',name:'SECRET HOLD',status:'review',reportedQuantity:-1},
  {sku:'1004',name:'SECRET MISSING',status:'available',reportedQuantity:1},
]});
const first=(sourceSku,units,countedAt=at)=>({sourceSku,units,countedAt,
  counterId:randomUUID(),witnessId:randomUUID()});
const second=(sourceSku,units,countedAt=at)=>({sourceSku,units,countedAt,
  counterId:randomUUID()});
const evidence=()=>({schemaVersion:1,physicalManifestSha256:sourceHash,
  wooExportSha256:wooHash,linkDrafts:[],cycleCounts:[first('1001',3),first('1002',0)]});
const draft=(recounts=[])=>({schemaVersion:1,physicalManifestSha256:sourceHash,
  wooExportSha256:wooHash,cutoverEvidenceSha256:evidenceHash,recounts});
const assess=(extra={})=>assessSharedWooInventoryCutover({physical:physical(),
  wooExport:{rows:[{ID:'900',Type:'simple',SKU:'WEB',Name:'SECRET SITE'}]},
  wooExportSha256:wooHash,evidence:evidence(),cutoverEvidenceSha256:evidenceHash,
  now,...extra});

test('second independently entered claims produce aggregate matches, conflicts, and missing items without approval',()=>{
  const r=assess({secondRecounts:draft([second('1001',3),second('1002',1)])});
  assert.equal(r.secondRecountSummary.supplied,true);
  assert.equal(r.secondRecountSummary.claimedMatchingFirst,1);
  assert.equal(r.secondRecountSummary.claimedDisagreements,1);
  assert.equal(r.secondRecountSummary.missingSecondClaims,1);
  assert.equal(r.issueCounts.independent_recounts_disagree,1);
  assert.equal(r.issueCounts.independent_second_recount_missing,1);
  for(const key of ['counterIdentityIndependentlyVerified','physicalQuantitiesIndependentlyVerified',
    'websiteReservationsReconciled','importOrStockWriteAuthorized'])
    assert.equal(r.secondRecountSummary[key],false);
  for(const key of ['checkoutAuthorized','uploadOrImportReady','wooStockMutationsAllowed',
    'productCreationAllowed','lateGatewayGuardVerified']) assert.equal(r[key],false);
  const printed=renderSharedWooCutoverReadiness(r);
  assert.match(printed,/Phase 4\.3 second recount claim review/);
  for(const secret of ['SECRET DRESS','SECRET SIZE L','SECRET SITE','1001','1002','1003','1004'])
    assert.equal(printed.includes(secret),false,'Private names and SKUs must never leak');
});

test('backwards compatible when no second file; missing first and quarantined records cannot be released',()=>{
  const noDraft=assess();
  assert.equal(noDraft.secondRecountSummary.supplied,false);
  assert.equal(noDraft.issueCounts.independent_second_recount_missing,undefined);
  const r=assess({secondRecounts:draft([second('1001',3),second('1002',0),
    second('1003',0),second('1004',1)])});
  assert.equal(r.secondRecountSummary.claimedMatchingFirst,2);
  assert.equal(r.secondRecountSummary.quarantinedSecondClaims,1);
  assert.equal(r.secondRecountSummary.secondWithoutFirst,1);
  assert.equal(r.issueCounts.second_recount_on_quarantined_item,1);
  assert.equal(r.issueCounts.second_recount_without_first,1);
  assert.equal(r.counts.sourceQuarantined,1);
  assert.equal(r.uploadOrImportReady,false);
});

test('stale, future, and distant second observations are treated as independent review blockers',()=>{
  const r=assess({secondRecounts:draft([
    second('1001',3,'2026-11-12T17:00:00.000Z'),
    second('1002',0,'2026-11-16T17:00:00.000Z'),
  ])});
  assert.equal(r.issueCounts.second_recount_stale_or_future,2);
  assert.equal(r.issueCounts.second_recount_too_far_from_first,2);
  assert.equal(r.secondRecountSummary.claimedMatchingFirst,2);
  assert.equal(r.currentPhysicalCountsIndependentlyVerified,false);
});

test('reused first-counter/witness IDs, arbitrary fields and broken evidence hashes fail closed',()=>{
  const e=evidence();
  for(const reused of [e.cycleCounts[0].counterId,e.cycleCounts[0].witnessId])
    assert.throws(()=>assess({evidence:e,secondRecounts:draft([
      {...second('1001',3),counterId:reused},
    ])}),/invalid/);
  const good=draft([second('1001',3)]);
  for(const change of [
    {physicalManifestSha256:'d'.repeat(64)}, {wooExportSha256:'d'.repeat(64)},
    {cutoverEvidenceSha256:'d'.repeat(64)}, {schemaVersion:2},
    {paymentAccount:'PRIVATE'}, {recounts:[second('1001',3),second('1001',2)]},
    {recounts:[{...second('1001',3),customerName:'SECRET'}]},
    {recounts:[{...second('1001',3),units:-1}]},
    {recounts:[{...second('1001',3),units:1.5}]},
    {recounts:[{...second('1001',3),countedAt:'not-a-date'}]},
  ]) assert.throws(()=>assess({secondRecounts:{...good,...change}}),/invalid/);
  assert.throws(()=>assess({secondRecounts:good,evidence:null}),/invalid/);
  assert.throws(()=>assess({secondRecounts:good,cutoverEvidenceSha256:null}),/invalid/);
  const unknown=assess({secondRecounts:draft([second('9999',1)])});
  assert.equal(unknown.issueCounts.second_recount_unknown_source,1);
  assert.equal(unknown.checkoutAuthorized,false);
});

test('real historical source retains 1,571 rows and 41 holds',()=>{
  const r=assess({physical:loadInStoreSnapshot(),evidence:null});
  assert.equal(r.counts.historicalSourceRows,1571);
  assert.equal(r.counts.sourceQuarantined,41);
  assert.equal(r.secondRecountSummary.supplied,false);
  assert.equal(r.checkoutAuthorized,false);
});

const script=fileURLToPath(new URL('../scripts/assess-shared-woo-cutover.mjs',import.meta.url));
const sha=value=>createHash('sha256').update(value).digest('hex');
test('CLI accepts a private second-count file with exact source hashes and rejects symlinks or insecure modes',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mansu-phase43-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const csv='ID,Type,SKU,Name,Published,Visibility in catalog,Regular price,Stock,Tax status\n'
    +'900,simple,SECRET-WEB,PRIVATE WEBSITE ITEM,1,visible,999.99,777,none\n';
  const source=loadInStoreSnapshot();
  const chosen=source.items.find(x=>x.status==='available' && /^[0-9]{1,8}$/.test(x.sku));
  assert.ok(chosen);
  const timestamp=new Date().toISOString();
  const e={schemaVersion:1,physicalManifestSha256:source.manifestHash,
    wooExportSha256:sha(csv),linkDrafts:[],cycleCounts:[first(chosen.sku,3,timestamp)]};
  const evidenceBytes=JSON.stringify(e);
  const review={schemaVersion:1,physicalManifestSha256:source.manifestHash,
    wooExportSha256:sha(csv),cutoverEvidenceSha256:sha(evidenceBytes),actions:[]};
  const secondClaims={schemaVersion:1,physicalManifestSha256:source.manifestHash,
    wooExportSha256:sha(csv),cutoverEvidenceSha256:sha(evidenceBytes),
    recounts:[second(chosen.sku,3,timestamp)]};
  const paths=['woo.csv','first.json','review.json','second.json'].map(x=>path.join(dir,x));
  [csv,evidenceBytes,JSON.stringify(review),JSON.stringify(secondClaims)]
    .forEach((x,i)=>fs.writeFileSync(paths[i],x,{mode:0o600}));
  const run=files=>spawnSync(process.execPath,[script,...files],{cwd:dir,
    encoding:'utf8',timeout:30000,env:{PATH:process.env.PATH}});
  const before=fs.readdirSync(dir);
  const ok=run(paths);
  assert.equal(ok.status,0,ok.stderr);
  assert.deepEqual(fs.readdirSync(dir),before,'No Woo import/ledger/output file created');
  assert.match(ok.stdout,/Second recount draft supplied: yes/);
  assert.match(ok.stdout,/Matching first count claims \(NOT verified\) \| 1/);
  for(const secret of ['SECRET-WEB','PRIVATE WEBSITE ITEM',chosen.sku])
    assert.equal(ok.stdout.includes(secret),false,'No private source names/SKUs');
  fs.chmodSync(paths[3],0o644);
  const unsafe=run(paths);
  assert.equal(unsafe.status,1);
  assert.equal(unsafe.stdout,'');
  fs.chmodSync(paths[3],0o600);
  fs.writeFileSync(paths[3],JSON.stringify({...secondClaims,
    cutoverEvidenceSha256:'f'.repeat(64)}),{mode:0o600});
  const wrong=run(paths);
  assert.equal(wrong.status,1);
  assert.equal(wrong.stdout,'');
  const link=path.join(dir,'second-link.json');
  fs.symlinkSync(paths[3],link);
  assert.equal(run([...paths.slice(0,3),link]).status,1);
  assert.equal(run(paths.slice(0,3)).status,0,'Previous Phase 4.2 CLI remains supported');
});
