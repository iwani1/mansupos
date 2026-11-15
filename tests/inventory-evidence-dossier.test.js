import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {OwnerMappingEvidence} from '../server/owner-mapping-evidence.js';
import {PhysicalCountClaims} from '../server/physical-count-claims.js';
import {buildInventoryDossier} from '../server/inventory-evidence-dossier.js';
import {inventoryDossierCsv} from '../src/inventory-dossier-csv.js';

const clock=Date.parse('2026-11-15T12:00:00.000Z');
const owner={id:'owner',role:'owner'};
const counter1={id:'counter-1',role:'cashier'};
const counter2={id:'counter-2',role:'manager'};
const physical=(items,other={})=>({
  source:'in-store-physical-stock-snapshot',
  manifestHash:'a'.repeat(64),summary:{items:items.length},items,...other,
});
const item=(reportRow,sku,status='available')=>({
  reportRow,sku,status,name:'PRIVATE BRAND',priceCents:45000,stock:900,
});
const p=()=>physical([
  item(1,'P1'),item(2,'P2'),item(3,'HOLD','review'),
  item(4,'P4'),item(5,'P5'),item(6,'P6'),
]);
const w=(extra={})=>({
  source:'woocommerce',complete:true,stale:false,isDemo:false,
  fetchedAt:new Date(clock).toISOString(),
  products:[
    {id:10,type:'simple',sku:'P1'},
    {id:20,type:'simple',sku:'P2'},
    {id:30,type:'simple',sku:'DIFFERENT'},
    {id:50,type:'simple',sku:'P5'},
    {id:60,type:'simple',sku:'P6'},
  ],...extra,
});
function setup(){
  const db=new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,actor TEXT NOT NULL,
    action TEXT NOT NULL,subject TEXT NOT NULL,created_at TEXT NOT NULL
  );CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit
    BEGIN SELECT RAISE(ABORT,'immutable');END;
    CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit
    BEGIN SELECT RAISE(ABORT,'immutable');END;`);
  const mappings=new OwnerMappingEvidence(db);
  const counts=new PhysicalCountClaims(db);
  return {db,mappings,counts};
}
function proposed(mappings,physical,website,row,productId){
  const r=mappings.review(physical,website,{},clock);
  const prior=r.items.find(x=>x.reportRow===row)?.latestReview?.id??null;
  mappings.submit(owner,physical,website,{
    reportRow:row,expectedRef:r.identityRef,expectedLatestReviewId:prior,
    decision:'propose_option',proposedProductId:productId,proposedVariationId:null,
    note:'Verify garment colour, size and fabric before any mapping.',
    requestId:randomUUID(),
  },clock);
}
function claim(counts,physical,website,reportRow,stage,units,actor){
  const r=counts.ownerReview(physical,website,{},clock);
  return counts.submit(actor,physical,website,{
    reportRow,stage,units,expectedRef:r.snapshotRef,requestId:randomUUID(),
  },clock);
}
const report=(ctx,physical,website,options={})=>
  buildInventoryDossier(physical,website,ctx.mappings,ctx.counts,options,clock);

test('owner dossier combines mapping proposals, count stages and holds without approving inventory',()=>{
  const ctx=setup();
  try{
    const source=p(),website=w();
    proposed(ctx.mappings,source,website,1,10);
    proposed(ctx.mappings,source,website,4,30);
    proposed(ctx.mappings,source,website,5,50);
    proposed(ctx.mappings,source,website,6,60);
    claim(ctx.counts,source,website,1,'first',4,counter1);
    claim(ctx.counts,source,website,1,'second',4,counter2);
    claim(ctx.counts,source,website,5,'first',6,counter1);
    claim(ctx.counts,source,website,5,'second',7,counter2);
    claim(ctx.counts,source,website,6,'first',8,counter1);
    const d=report(ctx,source,website);
    assert.equal(d.kind,'read-only-inventory-evidence-dossier');
    assert.equal(d.totalPhysical,6);
    assert.equal(d.total,6);
    assert.equal(d.evidenceVerified,true);
    assert.equal(d.checkoutAuthorized,false);
    assert.equal(d.stockImportAuthorized,false);
    assert.equal(d.mappingApproved,false);
    assert.equal(d.independentWitnessVerified,false);
    assert.equal(d.focusCounts.identity_hold,1);
    assert.equal(d.focusCounts.mapping_not_proposed,1);
    assert.equal(d.focusCounts.sku_difference,1);
    assert.equal(d.focusCounts.matching_count_unverified,1);
    assert.equal(d.focusCounts.count_discrepancy,1);
    assert.equal(d.focusCounts.second_count_missing,1);
    assert.equal(d.items[0].nextReview,'matching_count_unverified');
    assert.equal(d.items[0].countStage,'matching_claims_unverified');
    assert.equal(d.items[0].proposedWooProductId,10);
    assert.ok(d.items[0].blockers.includes('independent_physical_witness_unverified'));
    assert.ok(d.items[0].blockers.includes('woo_stock_reservation_unverified'));
    assert.equal(d.items[2].nextReview,'identity_hold');
    assert.equal(d.items[3].nextReview,'sku_difference');
    assert.equal(d.items[4].nextReview,'count_discrepancy');
    assert.equal(d.items[5].nextReview,'second_count_missing');
    assert.equal(d.items.every(x=>!x.stockImportAuthorized&&!x.mappingApproved),true);
    const json=JSON.stringify(d);
    assert.doesNotMatch(json,/PRIVATE BRAND|priceCents|"stock":900|firstUnits|secondUnits|counter-1|counter-2/);
    const csv=inventoryDossierCsv(d);
    assert.match(csv,/NOT APPROVED/);
    assert.doesNotMatch(csv,/PRIVATE BRAND|45000|900|counter-1|counter-2/);
    assert.equal(csv.trim().split('\r\n').length,7);
  }finally{ctx.db.close();}
});

test('paging and filtering preserve snapshot until review/count changes',()=>{
  const ctx=setup();
  try{
    const source=p(),website=w();
    const first=report(ctx,source,website,{page:1,pageSize:2});
    const last=report(ctx,source,website,{page:3,pageSize:2});
    assert.equal(first.items.length,2);
    assert.equal(last.items.length,2);
    assert.equal(first.dossierRef,last.dossierRef);
    const filter=report(ctx,source,website,{focus:'identity_hold'});
    assert.equal(filter.total,1);
    assert.equal(filter.items[0].reportRow,3);
    assert.equal(report(ctx,source,website,{search:'P6'}).items[0].reportRow,6);
    assert.equal(report(ctx,source,website,{search:'6'}).total,1);
    proposed(ctx.mappings,source,website,1,10);
    const after=report(ctx,source,website);
    assert.notEqual(after.dossierRef,first.dossierRef);
    assert.equal(after.items[0].ownerMappingDecision,'propose_option');
    claim(ctx.counts,source,website,1,'first',10,counter1);
    assert.notEqual(report(ctx,source,website).dossierRef,after.dossierRef);
    assert.equal(report(ctx,source,website).items[0].firstClaimRecorded,true);
    const refresh=w({fetchedAt:new Date(clock+1000).toISOString()});
    assert.equal(report(ctx,source,refresh,{page:2,pageSize:2}).dossierRef,
      report(ctx,source,website).dossierRef);
    for(const args of [{focus:'approved'},{page:0},{pageSize:51},
      {search:'x'.repeat(65)}]){
      assert.throws(()=>report(ctx,source,website,args));
    }
    const changed=w({products:[{id:10,type:'simple',sku:'CHANGED'}]});
    assert.notEqual(report(ctx,source,changed).dossierRef,
      report(ctx,source,website).dossierRef);
  }finally{ctx.db.close();}
});

test('source evidence cannot be used as an approved dossier or private CSV export',()=>{
  const ctx=setup();
  try{
    const source=p();
    const invalid=w({complete:false,stale:true});
    const d=report(ctx,source,invalid);
    assert.equal(d.evidenceVerified,false);
    assert.equal(d.checkoutAuthorized,false);
    assert.equal(d.stockImportAuthorized,false);
    assert.ok(d.items[0].blockers.includes('source_evidence_unverified'));
    assert.throws(()=>inventoryDossierCsv(d));
    assert.throws(()=>inventoryDossierCsv({...report(ctx,source,w()),
      checkoutAuthorized:true}));
    const broken=physical([item(1,'A'),item(1,'B')]);
    assert.throws(()=>report(ctx,broken,w()),
      e=>e.code==='INVENTORY_DOSSIER_SOURCE_MISMATCH');
  }finally{ctx.db.close();}
});

test('dossier CSV guards spreadsheet formulas and never includes numeric count claims',()=>{
  const ctx=setup();
  try{
    const source=physical([item(1,'=1+1')]);
    const d=report(ctx,source,w());
    const csv=inventoryDossierCsv(d);
    assert.match(csv,/"'=1\+1"/);
    assert.doesNotMatch(csv,/PRIVATE BRAND|priceCents/);
    assert.equal(csv.trim().split('\r\n').length,2);
    assert.throws(()=>inventoryDossierCsv({...d,items:[{
      ...d.items[0],mappingApproved:true,
    }]}));
  }finally{ctx.db.close();}
});
