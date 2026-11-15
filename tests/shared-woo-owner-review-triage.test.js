import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { assessSharedWooInventoryCutover } from '../server/shared-woo-cutover-readiness.js';
import { renderSharedWooCutoverReadiness } from '../scripts/assess-shared-woo-cutover.mjs';
import { loadInStoreSnapshot } from '../server/instore-catalog.js';

const physicalHash='a'.repeat(64),wooHash='b'.repeat(64),evidenceHash='c'.repeat(64);
const physical=()=>({manifestHash:physicalHash,items:[
  {sku:'1001',name:'SECRET DRESS',status:'available',reportedQuantity:3},
  {sku:'1002',name:'SECRET SIZE M',status:'out_of_stock',reportedQuantity:0},
  {sku:'1003',name:'PRIVATE HOLD',status:'review',reportedQuantity:-1},
  {sku:'1004',name:'SECRET NEW',status:'available',reportedQuantity:1},
]});
const woo=()=>({rows:[
  {ID:'301',Type:'simple',SKU:'1001',Name:'WOO HIDDEN',Stock:'90'},
  {ID:'400',Type:'variable',SKU:'PARENT'},
  {ID:'401',Type:'variation',Parent:'id:400',SKU:'1002'},
  {ID:'500',Type:'variation',Parent:'id:999',SKU:'ORPHAN'},
]});
const links=()=>[
  {sourceSku:'1001',target:'existing_woo',wooProductId:301,
    wooVariationId:null,reviewEvidenceId:randomUUID()},
  {sourceSku:'1002',target:'existing_woo',wooProductId:400,
    wooVariationId:401,reviewEvidenceId:randomUUID()},
  {sourceSku:'1004',target:'new_woo_required'},
];
const evidence=()=>({schemaVersion:1,physicalManifestSha256:physicalHash,wooExportSha256:wooHash,
  linkDrafts:links(),cycleCounts:[
    {sourceSku:'1001',units:2,countedAt:'2026-11-15T18:00:00.000Z',
      counterId:randomUUID(),witnessId:randomUUID()},
    {sourceSku:'1002',units:0,countedAt:'2026-11-15T18:00:00.000Z',
      counterId:randomUUID(),witnessId:randomUUID()},
  ]});
const action=(sourceRow,task,state)=>({sourceRow,task,state});
const draft=(actions=[])=>({
  schemaVersion:1,physicalManifestSha256:physicalHash,wooExportSha256:wooHash,
  cutoverEvidenceSha256:evidenceHash,actions,
});
const assess=(overrides={})=>assessSharedWooInventoryCutover({
  physical:physical(),wooExport:woo(),wooExportSha256:wooHash,
  evidence:evidence(),cutoverEvidenceSha256:evidenceHash,
  now:Date.parse('2026-11-15T18:30:00.000Z'),...overrides,
});
const queue=(assessment,name)=>assessment.reviewWorkflow.reviewQueues.find(x=>x.task===name);

test('Phase 4.2 groups quarantines, Woo export defects, identity, recount and variation ambiguities',()=>{
  const report=assess();
  assert.equal(queue(report,'quarantine').priority,'P0');
  assert.equal(queue(report,'quarantine').affectedSourceRows,1);
  assert.deepEqual(queue(report,'quarantine').sampledSourceRows,[3]);
  assert.equal(queue(report,'export_integrity').hasGlobalIssue,true);
  assert.equal(queue(report,'export_integrity').affectedSourceRows,0);
  assert.equal(queue(report,'identity').affectedSourceRows,1);
  assert.deepEqual(queue(report,'identity').sampledSourceRows,[4]);
  assert.equal(queue(report,'physical_recount').affectedSourceRows,2);
  assert.deepEqual(queue(report,'physical_recount').sampledSourceRows,[1,4]);
  assert.equal(queue(report,'variation_owner').affectedSourceRows,1);
  assert.deepEqual(queue(report,'variation_owner').sampledSourceRows,[2]);
  assert.equal(report.reviewWorkflow.draftActionsRecorded,0);
  assert.equal(queue(report,'physical_recount').casesStillWithoutDraftAction,2);
  for(const flag of ['ownerIdentityIndependentlyVerified',
    'physicalRecountIndependentlyVerified','ownerSignOffIssued',
    'importOrStockWriteAuthorized'])
    assert.equal(report.reviewWorkflow[flag],false);
  assert.equal(report.lateGatewayGuardVerified,false);
  assert.equal(report.checkoutAuthorized,false);
  assert.equal(report.wooStockMutationsAllowed,false);
  const payload=JSON.stringify(report);
  for(const secret of ['SECRET DRESS','SECRET SIZE M','WOO HIDDEN','PARENT','1001','1002','1003','1004'])
    assert.equal(payload.includes(secret),false,'Never expose private item data');
});

test('private hash-bound workflow annotations never remove blockers or constitute authenticated sign-off',()=>{
  const report=assess({reviewDraft:draft([
    action(3,'quarantine','owner_decision_required'),
    action(0,'export_integrity','investigating'),
    action(4,'identity','investigating'),
    action(1,'physical_recount','recount_requested'),
    action(2,'variation_owner','installed_site_check_required'),
  ])});
  assert.equal(report.reviewWorkflow.usesPrivateSourceBoundDraft,true);
  assert.equal(report.reviewWorkflow.draftActionsRecorded,5);
  assert.equal(queue(report,'physical_recount').casesStillWithoutDraftAction,1);
  assert.equal(queue(report,'physical_recount').draftStateCounts.recount_requested,1);
  assert.equal(queue(report,'quarantine').draftStateCounts.owner_decision_required,1);
  assert.equal(report.issueCounts.quarantined_source_record,1);
  assert.equal(report.reviewWorkflow.ownerSignOffIssued,false);
  assert.equal(report.reviewWorkflow.importOrStockWriteAuthorized,false);
  assert.equal(report.uploadOrImportReady,false);
  assert.equal(report.productCreationAllowed,false);
  const output=renderSharedWooCutoverReadiness(report);
  assert.match(output,/Phase 4\.2 owner-review triage/);
  assert.match(output,/owner_decision_required: 1/);
  assert.doesNotMatch(output,/SECRET DRESS|PARENT|1001|1002/);
  assert.throws(()=>renderSharedWooCutoverReadiness({
    ...report,reviewWorkflow:{...report.reviewWorkflow,ownerSignOffIssued:true},
  }),/unsafe report/);
});

test('wrong source, Woo or evidence hash and any arbitrary review text or approved state fail closed',()=>{
  const good=draft([action(1,'physical_recount','recount_requested')]);
  for(const change of [
    {physicalManifestSha256:'f'.repeat(64)},
    {wooExportSha256:'f'.repeat(64)},
    {cutoverEvidenceSha256:'f'.repeat(64)},
    {schemaVersion:2},
    {arbitraryCustomerEmail:'private@example.com'},
    {actions:[action(1,'physical_recount','approved')]},
    {actions:[action(1,'quarantine','investigating')]},
    {actions:[action(99,'identity','investigating')]},
    {actions:[action(3,'quarantine','investigating'),
      action(3,'quarantine','owner_decision_required')]},
    {actions:[{...action(1,'physical_recount','investigating'),privateNotes:'SECRET'}]},
    {actions:[action(-1,'identity','open')]},
  ])assert.throws(()=>assess({reviewDraft:{...good,...change}}),/invalid/);
  assert.throws(()=>assess({reviewDraft:good,cutoverEvidenceSha256:null}),/invalid/);
  assert.throws(()=>assess({reviewDraft:good,evidence:null}),/invalid/);
});

test('one source row may occupy multiple queues; task counts never claim physical stock quantity',()=>{
  const report=assess();
  const rowsAcrossQueues=report.reviewWorkflow.reviewQueues.reduce(
    (sum,x)=>sum+x.affectedSourceRows,0);
  assert.equal(rowsAcrossQueues,5);
  assert.equal(physical().items.length,4);
  assert.equal(report.reviewWorkflow.ownerSignOffIssued,false);
});

test('verified historical source remains 1,571 rows with 41 holds, not verified Woo stock',()=>{
  const result=assess({physical:loadInStoreSnapshot(),evidence:null});
  assert.equal(result.counts.historicalSourceRows,1571);
  assert.equal(result.counts.sourceQuarantined,41);
  assert.equal(queue(result,'quarantine').affectedSourceRows,41);
  assert.equal(queue(result,'identity').affectedSourceRows,1530);
  assert.equal(queue(result,'physical_recount').affectedSourceRows,1530);
  assert.equal(result.reviewWorkflow.usesPrivateSourceBoundDraft,false);
  assert.equal(result.reviewWorkflow.ownerSignOffIssued,false);
});

const script=fileURLToPath(new URL('../scripts/assess-shared-woo-cutover.mjs',import.meta.url));
const sha=value=>createHash('sha256').update(value).digest('hex');
test('CLI accepts 0600 owner-review draft bound to exact crosswalk bytes; never writes files or prints private details',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mansu-phase42-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const csv='ID,Type,SKU,Name,Published,Visibility in catalog,Regular price,Stock,Tax status\n'
    +'900,simple,website-only,TOP SECRET CLOTHING,1,visible,699.99,123,none\n';
  const snapshot=loadInStoreSnapshot();
  const sourceRow=snapshot.items.findIndex(x=>x.sku==='1434')+1;
  assert.ok(sourceRow>0);
  const input={schemaVersion:1,physicalManifestSha256:snapshot.manifestHash,
    wooExportSha256:sha(csv),
    linkDrafts:[{sourceSku:'1434',target:'new_woo_required'}],
    cycleCounts:[]};
  const evidenceJson=JSON.stringify(input);
  const ownerDraft={schemaVersion:1,physicalManifestSha256:snapshot.manifestHash,
    wooExportSha256:sha(csv),cutoverEvidenceSha256:sha(evidenceJson),
    actions:[{sourceRow,task:'identity',state:'owner_decision_required'}]};
  const paths=[path.join(dir,'export.csv'),path.join(dir,'evidence.json'),path.join(dir,'review.json')];
  for(const [index,bytes] of [csv,evidenceJson,JSON.stringify(ownerDraft)].entries())
    fs.writeFileSync(paths[index],bytes,{mode:0o600});
  const run=(reviewPath=paths[2])=>spawnSync(process.execPath,[script,paths[0],paths[1],reviewPath],{
    cwd:dir,encoding:'utf8',timeout:30000,env:{PATH:process.env.PATH}});
  const before=fs.readdirSync(dir);
  const passed=run();
  assert.equal(passed.status,0,passed.stderr);
  assert.deepEqual(fs.readdirSync(dir),before,'No new import or stock adjustment files');
  assert.match(passed.stdout,/Phase 4\.2 owner-review triage/);
  assert.match(passed.stdout,/owner_decision_required: 1/);
  assert.match(passed.stdout,/Owner identity, physical recount and final sign-off: NOT INDEPENDENTLY VERIFIED/);
  for(const secret of ['TOP SECRET CLOTHING','website-only','699.99','1434'])
    assert.equal(passed.stdout.includes(secret),false,'No private item details in report');
  fs.chmodSync(paths[2],0o644);
  const unsafe=run();
  assert.equal(unsafe.status,1);
  assert.equal(unsafe.stdout,'');
  fs.chmodSync(paths[2],0o600);
  const wrong={...ownerDraft,cutoverEvidenceSha256:'0'.repeat(64)};
  fs.writeFileSync(paths[2],JSON.stringify(wrong),{mode:0o600});
  const mismatch=run();
  assert.equal(mismatch.status,1);
  assert.equal(mismatch.stdout,'');
  const symlink=path.join(dir,'review-symlink.json');
  fs.symlinkSync(paths[2],symlink);
  const linked=run(symlink);
  assert.equal(linked.status,1);
  assert.equal(linked.stdout,'');
});
