import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {OwnerMappingEvidence} from '../server/owner-mapping-evidence.js';
import {PhysicalCountClaims} from '../server/physical-count-claims.js';
import {prepareInventoryAcceptance} from '../server/inventory-acceptance-preparation.js';

const clock=Date.parse('2026-11-15T12:00:00.000Z');
const owner={id:'owner',role:'owner'};
const one={id:'worker1',role:'cashier'};
const two={id:'worker2',role:'manager'};
const source=(items,extra={})=>({
  source:'in-store-physical-stock-snapshot',manifestHash:'a'.repeat(64),
  summary:{items:items.length},items,...extra,
});
const row=(reportRow,sku,status='available')=>({
  reportRow,sku,status,name:'CONFIDENTIAL STYLE',stock:300,priceCents:32000,
});
const physical=()=>source([row(1,'MATCH'),row(2,'MISSING'),row(3,'HOLD','review'),
  row(4,'DIFFERENT')]);
const website=(extra={})=>({
  source:'woocommerce',fetchedAt:new Date(clock).toISOString(),
  complete:true,isDemo:false,stale:false,
  products:[{type:'simple',id:51,sku:'MATCH'},{type:'simple',id:52,sku:'UNRELATED'}],
  ...extra,
});
const setup=()=>{
  const db=new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE audit(
    id INTEGER PRIMARY KEY AUTOINCREMENT,actor TEXT NOT NULL,
    action TEXT NOT NULL,subject TEXT NOT NULL,created_at TEXT NOT NULL
  );CREATE TRIGGER immutable BEFORE UPDATE ON audit
    BEGIN SELECT RAISE(ABORT,'immutable');END;`);
  return {db,mapping:new OwnerMappingEvidence(db),counts:new PhysicalCountClaims(db)};
};
const review=(services,p,w,options={})=>
  prepareInventoryAcceptance(p,w,services.mapping,services.counts,options,clock);
function proposal(services,p,w,rowNumber,id){
  const r=services.mapping.review(p,w,{},clock);
  services.mapping.submit(owner,p,w,{
    reportRow:rowNumber,expectedRef:r.identityRef,
    expectedLatestReviewId:null,decision:'propose_option',
    proposedProductId:id,proposedVariationId:null,
    note:'Check colour size and physical item identity independently.',
    requestId:randomUUID(),
  },clock);
}
function count(services,p,w,number,stage,qty,actor){
  const r=services.counts.ownerReview(p,w,{},clock);
  services.counts.submit(actor,p,w,{
    reportRow:number,stage,units:qty,expectedRef:r.snapshotRef,
    requestId:randomUUID(),
  },clock);
}
test('acceptance preparation never treats owner proposals or matching staff counts as approvals',()=>{
  const services=setup();
  try{
    const p=physical(),w=website();
    proposal(services,p,w,1,51);
    count(services,p,w,1,'first',5,one);
    count(services,p,w,1,'second',5,two);
    const r=review(services,p,w);
    assert.equal(r.kind,'read-only-inventory-acceptance-preparation');
    assert.equal(r.total,4);
    assert.equal(r.historicalSourceVerified,true);
    assert.equal(r.ownerApproved,false);
    assert.equal(r.acceptanceCertificateIssued,false);
    assert.equal(r.mappingApproved,false);
    assert.equal(r.independentWitnessVerified,false);
    assert.equal(r.stockImportAuthorized,false);
    assert.equal(r.sharedStockVerified,false);
    assert.equal(r.checkoutAuthorized,false);
    assert.deepEqual(r.observations,{
      totalHistoricalRows:4,identityHolds:1,provisionalOwnerProposals:1,
      matchingStaffDeclarations:1,independentWitnessedRows:0,
      formallyApprovedCrosswalkRows:0,stockImportAuthorizedRows:0,
    });
    const first=r.items[0];
    assert.equal(first.proposalRecorded,true);
    assert.equal(first.staffClaimsAgree,true);
    assert.equal(first.approved,false);
    assert.equal(first.checks.find(x=>x.gate==='owner_option_proposal').state,'recorded_unverified');
    assert.equal(first.checks.find(x=>x.gate==='two_count_claims').state,'matching_unwitnessed');
    assert.equal(first.checks.find(x=>x.gate==='independent_physical_witness').state,'not_verified');
    assert.equal(first.checks.find(x=>x.gate==='formal_mapping_signoff').state,'not_authorized');
    assert.equal(r.items[2].identityHeld,true);
    assert.equal(r.items[2].checks[0].state,'investigate');
    assert.equal(r.items[1].checks[1].state,'missing');
    assert.equal(r.items.every(x=>!x.readyForCheckout&&!x.readyForInventoryImport),true);
    assert.doesNotMatch(JSON.stringify(r),/CONFIDENTIAL STYLE|priceCents|"stock":300|firstUnits|secondUnits|worker1|worker2/);
    assert.equal(services.db.prepare('SELECT COUNT(*) AS n FROM audit').get().n,3);
  }finally{services.db.close();}
});

test('snapshot stable over pagination and Woo refresh, changes on owner/worker evidence',()=>{
  const services=setup();
  try{
    const p=physical(),w=website();
    const r=review(services,p,w,{pageSize:2});
    const page2=review(services,p,w,{pageSize:2,page:2});
    assert.equal(r.items.length,2);
    assert.equal(page2.items.length,2);
    assert.equal(r.preparationRef,page2.preparationRef);
    assert.equal(page2.hasMore,false);
    assert.equal(review(services,p,w,{search:'MATCH'}).total,1);
    assert.equal(review(services,p,w,{gate:'historical_source_integrity'}).total,0);
    assert.equal(review(services,p,w,{gate:'owner_option_proposal'}).total,4);
    proposal(services,p,w,1,51);
    const after=review(services,p,w);
    assert.notEqual(after.preparationRef,r.preparationRef);
    assert.equal(review(services,p,w,{gate:'owner_option_proposal'}).total,3);
    count(services,p,w,1,'first',2,one);
    assert.notEqual(review(services,p,w).preparationRef,after.preparationRef);
    const refreshed=website({fetchedAt:new Date(clock+1000).toISOString()});
    assert.equal(review(services,p,refreshed).preparationRef,
      review(services,p,w).preparationRef);
    const changed=website({products:[{type:'simple',id:51,sku:'CHANGED'}]});
    assert.notEqual(review(services,p,changed).preparationRef,
      review(services,p,w).preparationRef);
    const badSource=source(p.items,{manifestHash:'b'.repeat(64)});
    assert.notEqual(review(services,badSource,w).preparationRef,
      review(services,p,w).preparationRef);
    for(const opt of [{gate:'approved'},{page:0},{pageSize:51},
      {search:'z'.repeat(65)}]){
      assert.throws(()=>review(services,p,w,opt));
    }
  }finally{services.db.close();}
});

test('unverified source yields additional unverified evidence, never clearance',()=>{
  const services=setup();
  try{
    const d=review(services,physical(),website({complete:false,stale:true}));
    assert.equal(d.historicalSourceVerified,false);
    assert.equal(d.items[0].checks[0].gate,'historical_source_integrity');
    assert.equal(d.items[0].checks[0].state,'not_verified');
    assert.equal(d.observations.stockImportAuthorizedRows,0);
    assert.equal(d.checkoutAuthorized,false);
    assert.ok(d.mandatoryGlobalEvidence.length>=5);
    assert.equal(review(services,physical(),website(),{
      gate:'historical_source_integrity',
    }).total,0);
  }finally{services.db.close();}
});
