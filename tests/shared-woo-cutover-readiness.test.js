import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { assessSharedWooInventoryCutover } from '../server/shared-woo-cutover-readiness.js';
import { loadInStoreSnapshot } from '../server/instore-catalog.js';

const sourceHash='a'.repeat(64);
const exportHash='b'.repeat(64);
const when='2026-11-15T17:00:00.000Z';
const now=Date.parse('2026-11-15T17:20:00.000Z');
const physical=()=>({
  source:'in-store-physical-stock-snapshot',manifestHash:sourceHash,
  items:[
    {sku:'1001',name:'SECRET RED DRESS',status:'available',reportedQuantity:3,priceCents:999999},
    {sku:'1002',name:'SECRET SIZE L',status:'out_of_stock',reportedQuantity:0,priceCents:123456},
    {sku:'1003',name:'PRIVATE HOLD',status:'review',reportedQuantity:-5,reviewReasons:['private supplier']},
    {sku:'1004',name:'PRIVATE NEW PRODUCT',status:'available',reportedQuantity:7,priceCents:654321},
  ],
});
const woo=()=>({rows:[
  {ID:'300',Type:'simple',SKU:'1001',Name:'Woo private name',Stock:'9000','Regular price':'999.99'},
  {ID:'400',Type:'variable',SKU:'VARIABLE_PARENT',Name:'Parent private name',Stock:'1000'},
  {ID:'401',Type:'variation',SKU:'1002',Parent:'id:400',Stock:'999'},
  {ID:'402',Type:'variation',SKU:'',Parent:'id:400',Stock:'999'},
]});
const existing=(sourceSku,wooProductId,wooVariationId=null)=>({
  sourceSku,target:'existing_woo',wooProductId,wooVariationId,reviewEvidenceId:randomUUID(),
});
const count=(sourceSku,units,countedAt=when)=>({
  sourceSku,units,countedAt,counterId:randomUUID(),witnessId:randomUUID(),
});
const evidence=()=>({
  schemaVersion:1,physicalManifestSha256:sourceHash,wooExportSha256:exportHash,
  linkDrafts:[existing('1001',300),existing('1002',400,401),
    {sourceSku:'1004',target:'new_woo_required'}],
  cycleCounts:[count('1001',3),count('1002',0),count('1004',8)],
});
const assess=(changes={})=>assessSharedWooInventoryCutover({
  physical:physical(),wooExport:woo(),wooExportSha256:exportHash,
  evidence:evidence(),now,...changes,
});

test('offline draft crosswalk and two-person counts preserve Woo stock ownership and block all release flags',()=>{
  const result=assess();
  assert.equal(result.kind,'read-only-shared-woo-cutover-readiness');
  assert.deepEqual(result.counts,{
    historicalSourceRows:4,sourceQuarantined:1,
    eligiblePositiveHistorically:2,eligibleZeroHistorically:1,
    wooExportRows:4,wooParents:2,wooVariations:2,
    proposedExistingLinks:2,proposedNewIdentities:1,
    claimedRecentTwoPersonCounts:3,claimedStaleTwoPersonCounts:0,
    countVsHistoricalDiscrepancies:1,
  });
  assert.equal(result.issueCounts.quarantined_source_record,1);
  assert.equal(result.issueCounts.new_woo_product_identity_unassigned,1);
  assert.equal(result.issueCounts.count_differs_from_historical_pdf,1);
  assert.equal(result.issueCounts.existing_woo_parent_variation_mismatch,undefined);
  assert.equal(result.issueCounts.duplicate_woo_target_mapping,undefined);
  assert.equal(result.issueCounts.fresh_two_person_count_missing,undefined);
  assert.equal(result.issueCounts.identity_mapping_missing,undefined);
  assert.equal(result.auditOnly,true);
  assert.equal(result.decision,'manual_identity_count_and_live_woo_review_required');
  for(const key of ['allPhysicalMappingsIndependentlyVerified',
    'currentPhysicalCountsIndependentlyVerified','existingWooIdentitiesOwnerApproved',
    'inventoryVariationOwnershipVerified','wooExportCompleteAndCurrentVerified',
    'websiteAndStoreStockSingleAuthorityTested','lastUnitConcurrencyVerified',
    'retailPriceAndTaxApproved','wholesaleCashCustodyVerified',
    'lateGatewayGuardVerified','wooStockMutationsAllowed','productCreationAllowed',
    'checkoutAuthorized','uploadOrImportReady','sellerOrManagerApprovalIssued']) {
    assert.equal(result[key],false,key+' must remain closed');
  }
  const output=JSON.stringify(result);
  for(const sensitive of [
    'SECRET RED DRESS','PRIVATE HOLD','private supplier','Woo private name',
    '999.99','9000','1001','1002','1003','1004','654321','123456',
    ...evidence().linkDrafts.filter(x=>x.reviewEvidenceId).map(x=>x.reviewEvidenceId),
  ]) assert.equal(output.includes(sensitive),false,'Must not disclose source SKU, name, price or review token');
});

test('no draft crosswalk leaves every eligible source row pending; historical stock never becomes current Woo quantity',()=>{
  const result=assess({evidence:null});
  assert.equal(result.issueCounts.no_source_bound_cutover_evidence,1);
  assert.equal(result.issueCounts.identity_mapping_missing,3);
  assert.equal(result.issueCounts.fresh_two_person_count_missing,3);
  assert.equal(result.counts.claimedRecentTwoPersonCounts,0);
  assert.equal(result.checkoutAuthorized,false);
  assert.equal(result.uploadOrImportReady,false);
});

test('wrong snapshot hashes, extra private fields, invalid reviewers and duplicate input rows refuse any plan',()=>{
  for(const change of [
    {physicalManifestSha256:'c'.repeat(64)},
    {wooExportSha256:'d'.repeat(64)},
    {privateBankAccount:'123-456'},
    {linkDrafts:[...evidence().linkDrafts,existing('1001',300)]},
    {cycleCounts:[count('1001',3),count('1001',4)]},
    {cycleCounts:[{...count('1001',2),customerName:'secret'}]},
    {cycleCounts:[{...count('1001',2),witnessId:'not-a-uuid'}]},
    {cycleCounts:[{...count('1001',2),counterId:'same',witnessId:'same'}]},
    {linkDrafts:[{sourceSku:'1004',target:'new_woo_required',wooId:7}]},
  ]) {
    assert.throws(()=>assess({evidence:{...evidence(),...change}}),/invalid/);
  }
  assert.throws(()=>assess({wooExportSha256:'bad'}),/invalid/);
  assert.throws(()=>assess({physical:{...physical(),manifestHash:'bad'}}),/invalid/);
});

test('bad parent/variation association, shared variation double-map, and unknown source cannot slip through',()=>{
  const bad=assess({evidence:{...evidence(),linkDrafts:[
    existing('1001',400,402),existing('1002',400,402),
    {sourceSku:'1004',target:'new_woo_required'},
  ]}});
  assert.equal(bad.issueCounts.variation_sku_unassigned_for_manual_review,2);
  assert.equal(bad.issueCounts.duplicate_woo_target_mapping,1);
  assert.equal(bad.existingWooIdentitiesOwnerApproved,false);
  const misparent=assess({evidence:{...evidence(),linkDrafts:[
    existing('1001',300,401),existing('1002',400,401),
  ]}});
  assert.equal(misparent.issueCounts.existing_woo_parent_variation_mismatch,1);
  assert.equal(misparent.issueCounts.identity_mapping_missing,1);
  const missing=assess({evidence:{...evidence(),linkDrafts:[
    ...evidence().linkDrafts,{sourceSku:'9999',target:'new_woo_required'},
  ]}});
  assert.equal(missing.issueCounts.link_for_unknown_source_sku,1);
});

test('held original record cannot be linked, counted or implied released',()=>{
  const proposal=evidence();
  proposal.linkDrafts.push(existing('1003',300));
  proposal.cycleCounts.push(count('1003',0));
  const result=assess({evidence:proposal});
  assert.equal(result.issueCounts.quarantined_item_must_not_link,1);
  assert.equal(result.issueCounts.quarantined_item_count_not_released,1);
  assert.equal(result.counts.sourceQuarantined,1);
  assert.equal(result.productCreationAllowed,false);
});

test('stale/future cycle-count claims and historical discrepancies are manual blockers, never automatic adjustment',()=>{
  const proposal=evidence();
  proposal.cycleCounts[0]=count('1001',9999,'2026-11-12T17:00:00.000Z');
  proposal.cycleCounts[1]=count('1002',0,'2026-11-16T17:00:00.000Z');
  const result=assess({evidence:proposal});
  assert.equal(result.counts.claimedStaleTwoPersonCounts,2);
  assert.equal(result.issueCounts.stale_or_future_physical_count_claim,2);
  assert.equal(result.counts.countVsHistoricalDiscrepancies,2);
  assert.equal(result.wooStockMutationsAllowed,false);
});

test('Woo duplicate IDs, duplicate SKUs and unsupported products block readiness even with matching source SKUs',()=>{
  const altered=woo();
  altered.rows.push({...altered.rows[0],ID:'300',SKU:'1002'});
  altered.rows.push({ID:'500',Type:'variation',SKU:'1001',Parent:'id:400'});
  altered.rows.push({ID:'501',Type:'external',SKU:'other'});
  const result=assess({wooExport:altered});
  assert.equal(result.issueCounts.duplicate_woo_id,1);
  assert.equal(result.issueCounts.duplicate_woo_sku,2);
  assert.equal(result.issueCounts.unsupported_woo_product_type,1);
  assert.equal(result.checkoutAuthorized,false);
});

test('verified historical November source retains 1,571 rows and 41 quarantined without converting PDF into sellable stock',()=>{
  const source=loadInStoreSnapshot();
  const result=assess({
    physical:source,wooExport:woo(),evidence:null,
    wooExportSha256:exportHash,
  });
  assert.equal(result.counts.historicalSourceRows,1571);
  assert.equal(result.counts.sourceQuarantined,41);
  assert.equal(result.counts.eligiblePositiveHistorically,1206);
  assert.equal(result.counts.eligibleZeroHistorically,324);
  assert.equal(result.issueCounts.identity_mapping_missing,1530);
  assert.equal(result.issueCounts.fresh_two_person_count_missing,1530);
  assert.equal(result.uploadOrImportReady,false);
  assert.equal(result.wooStockMutationsAllowed,false);
});
