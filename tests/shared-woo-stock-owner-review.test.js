import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { assessSharedWooInventoryCutover } from '../server/shared-woo-cutover-readiness.js';

const sourceHash='a'.repeat(64), exportHash='b'.repeat(64);
const physical=()=>({manifestHash:sourceHash,items:[
  {sku:'1001',status:'available',reportedQuantity:2,name:'PRIVATE RED DRESS'},
  {sku:'1002',status:'available',reportedQuantity:1,name:'PRIVATE BLUE DRESS'},
]});
const variable=(id,sku)=>({ID:String(id),Type:'variable',SKU:sku,Stock:'3','Manage stock?':'1'});
const variation=(id,parent,sku)=>({ID:String(id),Type:'variation',Parent:'id:'+parent,
  SKU:sku,Stock:'1','Manage stock?':'0'});
const link=(sku,parent,id)=>({sourceSku:sku,target:'existing_woo',
  wooProductId:parent,wooVariationId:id,reviewEvidenceId:randomUUID()});
const evidence=links=>({schemaVersion:1,physicalManifestSha256:sourceHash,
  wooExportSha256:exportHash,linkDrafts:links,
  cycleCounts:['1001','1002'].map((sourceSku,i)=>({sourceSku,units:i?1:2,
    countedAt:'2026-11-15T18:00:00.000Z',counterId:randomUUID(),witnessId:randomUUID()}))});
const assess=(rows,links)=>assessSharedWooInventoryCutover({physical:physical(),
  wooExport:{rows},wooExportSha256:exportHash,evidence:evidence(links),
  now:Date.parse('2026-11-15T18:30:00.000Z')});

test('two size variations linked to the same parent may share a managed Woo stock pool',()=>{
  const result=assess([variable(40,'PARENT'),variation(41,40,'1001'),variation(42,40,'1002')],
    [link('1001',40,41),link('1002',40,42)]);
  assert.equal(result.issueCounts.possible_shared_parent_managed_stock_pool,1);
  assert.equal(result.issueCounts.variation_stock_owner_requires_live_verification,2);
  assert.equal(result.issueCounts.duplicate_woo_target_mapping,undefined);
  assert.equal(result.issueCounts.existing_woo_parent_variation_mismatch,undefined);
  for(const flag of ['inventoryVariationOwnershipVerified','wooStockMutationsAllowed',
    'uploadOrImportReady','checkoutAuthorized','lateGatewayGuardVerified'])assert.equal(result[flag],false);
  const report=JSON.stringify(result);
  for(const secret of ['PRIVATE RED DRESS','PRIVATE BLUE DRESS','1001','1002','PARENT'])
    assert.equal(report.includes(secret),false,'Private inventory item data in aggregate report');
});
test('different parents avoid shared-pool suggestion but variation stock owner remains unverified',()=>{
  const result=assess([variable(40,'FIRST'),variation(41,40,'1001'),
    variable(50,'SECOND'),variation(51,50,'1002')],[link('1001',40,41),link('1002',50,51)]);
  assert.equal(result.issueCounts.possible_shared_parent_managed_stock_pool,undefined);
  assert.equal(result.issueCounts.variation_stock_owner_requires_live_verification,2);
  assert.equal(result.checkoutAuthorized,false);
});
test('orphan or wrongly parented variations block offline review even without draft mappings',()=>{
  const result=assess([{ID:'10',Type:'simple',SKU:'SIMPLE'},
    variation(41,999,'UNLINKED'),variation(42,10,'WRONG_TYPE'),
    {...variation(43,10,'INVALID_PARENT'),Parent:'bad-id'}],[]);
  assert.equal(result.issueCounts.orphan_or_invalid_woo_variation_parent,3);
  assert.equal(result.issueCounts.identity_mapping_missing,2);
  assert.ok(result.examples.some(x=>x.sourceRow===0 && x.code==='orphan_or_invalid_woo_variation_parent'));
  assert.equal(result.wooExportCompleteAndCurrentVerified,false);
  assert.equal(result.checkoutAuthorized,false);
});
test('invalid existing parent/variation crosswalk cannot claim independent stock owner',()=>{
  const result=assess([variable(40,'PARENT'),variation(41,40,'1001'),variation(42,40,'1002')],
    [link('1001',40,41),link('1002',999,42)]);
  assert.equal(result.issueCounts.existing_woo_parent_variation_mismatch,1);
  assert.equal(result.issueCounts.variation_stock_owner_requires_live_verification,1);
  assert.equal(result.issueCounts.possible_shared_parent_managed_stock_pool,undefined);
  assert.equal(result.wooStockMutationsAllowed,false);
  assert.equal(result.productCreationAllowed,false);
});
