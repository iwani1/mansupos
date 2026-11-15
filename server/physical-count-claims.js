import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { AppError } from './errors.js';
import { audit } from './db.js';
import { planPhysicalRecounts } from './physical-recount-plan.js';

// Inventory COUNT CLAIMS are local, append-only employee declarations.
// Neither a distinct login nor matching numbers proves a witnessed count.
// The authoritative Woo stock ledger is NEVER touched.
const idPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const refPattern=/^[a-f0-9]{64}$/;
const allowed=new Set(['provisional_match','missing_on_website']);
export const countClaimSchema=z.object({
  reportRow:z.number().int().min(1).max(10000),
  units:z.number().int().min(0).max(1000000),
  stage:z.enum(['first','second']),
  expectedRef:z.string().regex(refPattern),
  requestId:z.string().regex(idPattern),
}).strict();

function readClaims(db){
  const claims=[];
  for(const row of db.prepare("SELECT id,actor,subject,created_at FROM audit WHERE action='inventory.count_claim' ORDER BY id ASC").all()){
    let data;
    try{ data=JSON.parse(row.subject); }catch{ continue; }
    if(data?.schemaVersion!==1||!refPattern.test(data.planRef||'')||
       !refPattern.test(data.sourceHash||'')||
       !Number.isSafeInteger(data.reportRow)||data.reportRow<1||
       !['first','second'].includes(data.stage)||
       !Number.isSafeInteger(data.units)||data.units<0||
       !idPattern.test(data.requestId||''))continue;
    claims.push({...data,id:row.id,actor:row.actor,createdAt:row.created_at});
  }
  return claims;
}

function currentPlan(physical,website,clock){
  const rows=[];
  const plan=planPhysicalRecounts(physical,website,
    {page:1,pageSize:1},clock,rows);
  // A catalogue refresh timestamp is NOT an identity change. Bind employee
  // claims to exact source SKU/option identities, not Woo fetch timing.
  // Freshness is a separate hard precondition when creating a claim.
  const identityRef=createHash('sha256').update(JSON.stringify({
    sourceHash:plan.physicalManifestSha256,
    rows:rows.map(row=>({
      reportRow:row.reportRow,sku:row.sku,mappingStatus:row.mappingStatus,
      productId:row.candidateWooProductId,variationId:row.candidateWooVariationId,
    })),
  })).digest('hex');
  return {plan:{...plan,snapshotRef:identityRef},rows};
}

function claimsFor(claims,plan,row){
  const records=claims.filter(claim=>claim.planRef===plan.snapshotRef &&
    claim.sourceHash===plan.physicalManifestSha256 &&
    claim.reportRow===row.reportRow);
  return {
    first:records.find(claim=>claim.stage==='first')||null,
    second:records.find(claim=>claim.stage==='second')||null,
  };
}
function canCount(row){return allowed.has(row.mappingStatus);}
function currentStatus(row,first,second){
  if(!canCount(row))return 'identity_hold';
  if(!first)return 'first_needed';
  if(!second)return 'second_needed';
  return first.units===second.units?'matching_claims_unverified':'discrepant_claims';
}

export class PhysicalCountClaims {
  constructor(db){this.db=db;}

  // GET is safe for staff: never show another person's quantity or identity.
  worklist(user,physical,website,query={},clock=Date.now()){
    const {page=1,pageSize=25,search=''}=query;
    if(!Number.isSafeInteger(page)||page<1||page>10000||
       !Number.isSafeInteger(pageSize)||pageSize<1||pageSize>50||
       typeof search!=='string'||search.length>64)throw new AppError('Invalid count list filter.',400);
    const {plan,rows}=currentPlan(physical,website,clock);
    const claims=readClaims(this.db);
    const needle=search.trim().toUpperCase();
    const items=rows.map(row=>{
      const {first,second}=claimsFor(claims,plan,row);
      const stage=currentStatus(row,first,second);
      return {
        reportRow:row.reportRow,sku:row.sku,mappingStatus:row.mappingStatus,
        stage,
        // The first account CANNOT submit the blind second count.
        canSubmit:plan.evidenceVerified&&
          (stage==='first_needed'||stage==='second_needed'&&first.actor!==user.id)&&
          ['manager','cashier'].includes(user.role),
      };
    }).filter(row=>!needle||row.sku.toUpperCase().includes(needle)||
      String(row.reportRow).includes(needle));
    const total=items.length,pages=Math.max(1,Math.ceil(total/pageSize));
    return {
      kind:'local-unverified-physical-count-worklist',
      auditOnly:true,checkoutAuthorized:false,stockImportAuthorized:false,
      ownerApproved:false,independentWitnessVerified:false,
      evidenceVerified:plan.evidenceVerified,
      snapshotRef:plan.snapshotRef,
      page,pageSize,pages,total,hasMore:page<pages,
      items:items.slice((page-1)*pageSize,page*pageSize),
      note:'Quantities are withheld from staff to preserve a blind second count; submitted numbers are claims, never inventory.',
    };
  }

  submit(user,physical,website,raw,clock=Date.now()){
    const values=countClaimSchema.parse(raw);
    if(!['manager','cashier'].includes(user.role))
      throw new AppError('Only a named staff account may record a physical count claim.',403,'COUNT_ROLE_DENIED');

    const {plan,rows}=currentPlan(physical,website,clock);
    if(!plan.evidenceVerified || !refPattern.test(plan.physicalManifestSha256||'')){
      throw new AppError('The physical or Woo source observation is not verified or is stale. No count was recorded.',409,'COUNT_EVIDENCE_STALE');
    }
    if(values.expectedRef!==plan.snapshotRef)
      throw new AppError('Stock source or website observation changed. Reload the current count list.',409,'COUNT_SNAPSHOT_CHANGED');
    const selected=rows.find(row=>row.reportRow===values.reportRow);
    if(!selected||!canCount(selected)){
      throw new AppError('That historical source row has an unresolved product identity or stock hold.',409,'COUNT_ROW_HELD');
    }
    // The only ledger write occurs inside one local transaction, holding the
    // SQLite write lock while checking the first/second count and request key.
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const claims=readClaims(this.db);
      const replay=claims.find(row=>row.requestId===values.requestId);
      if(replay){
        const same=replay.actor===user.id&&replay.planRef===plan.snapshotRef&&
          replay.sourceHash===plan.physicalManifestSha256&&
          replay.reportRow===values.reportRow&&replay.units===values.units&&
          replay.stage===values.stage;
        if(!same)throw new AppError('Count request identifier was already used for different data.',409,'COUNT_IDEMPOTENCY_CONFLICT');
        this.db.exec('COMMIT');
        return {kind:'local-unverified-physical-count-claim',auditOnly:true,
          claimId:replay.id,stage:values.stage,replayed:true,recorded:true,
          stockImportAuthorized:false,checkoutAuthorized:false,ownerApproved:false,
          independentWitnessVerified:false};
      }
      const {first,second}=claimsFor(claims,plan,selected);
      if(values.stage==='first'&&first ||
         values.stage==='second'&&(!first||second)){
        throw new AppError('The requested counting stage has already been recorded or is not ready.',409,'COUNT_STAGE_CONFLICT');
      }
      if(values.stage==='second'&&first.actor===user.id){
        throw new AppError('A different signed-in employee must submit the second count.',403,'INDEPENDENT_ACCOUNT_REQUIRED');
      }
      audit(this.db,user.id,'inventory.count_claim',JSON.stringify({
        schemaVersion:1,sourceHash:plan.physicalManifestSha256,
        planRef:plan.snapshotRef,reportRow:values.reportRow,
        units:values.units,stage:values.stage,requestId:values.requestId,
        declarationId:randomUUID(),
      }));
      const last=this.db.prepare("SELECT id FROM audit WHERE action='inventory.count_claim' ORDER BY id DESC LIMIT 1").get();
      this.db.exec('COMMIT');
      return {kind:'local-unverified-physical-count-claim',auditOnly:true,
        claimId:last.id,stage:values.stage,replayed:false,recorded:true,
        stockImportAuthorized:false,checkoutAuthorized:false,ownerApproved:false,
        independentWitnessVerified:false};
    }catch(error){
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  // Only the Owner can inspect actual quantities and identify discrepancies.
  // This is explicitly NON-EXECUTING: no approve/accept/import endpoint exists.
  ownerReview(physical,website,query={},clock=Date.now()){
    const {page=1,pageSize=25,search=''}=query;
    if(!Number.isSafeInteger(page)||page<1||page>10000||
       !Number.isSafeInteger(pageSize)||pageSize<1||pageSize>50||
       typeof search!=='string'||search.length>64)throw new AppError('Invalid owner review filter.',400);
    const {plan,rows}=currentPlan(physical,website,clock);
    const claims=readClaims(this.db);
    const needle=search.trim().toUpperCase();
    const items=rows.map(row=>{
      const {first,second}=claimsFor(claims,plan,row);
      return {
        reportRow:row.reportRow,sku:row.sku,
        stage:currentStatus(row,first,second),
        firstUnits:first?.units??null,secondUnits:second?.units??null,
        firstActor:first?.actor??null,secondActor:second?.actor??null,
        firstSubmittedAt:first?.createdAt??null,secondSubmittedAt:second?.createdAt??null,
        // Matching numbers are declarations, not identity-verified witnesses.
        ownerApproved:false,stockImportAuthorized:false,
      };
    }).filter(row=>!needle||row.sku.toUpperCase().includes(needle)||
      String(row.reportRow).includes(needle));
    const currentIds=new Set(claims.filter(c=>c.planRef===plan.snapshotRef&&
      c.sourceHash===plan.physicalManifestSha256).map(c=>c.id));
    const staleClaimEvents=claims.filter(c=>!currentIds.has(c.id)).length;
    const totals={
      identityHolds:items.filter(row=>row.stage==='identity_hold').length,
      firstNeeded:items.filter(row=>row.stage==='first_needed').length,
      secondNeeded:items.filter(row=>row.stage==='second_needed').length,
      matchingUnverified:items.filter(row=>row.stage==='matching_claims_unverified').length,
      discrepancies:items.filter(row=>row.stage==='discrepant_claims').length,
    };
    const total=items.length,pages=Math.max(1,Math.ceil(total/pageSize));
    return {
      kind:'local-unverified-physical-count-owner-review',
      auditOnly:true,checkoutAuthorized:false,stockImportAuthorized:false,
      ownerApproved:false,independentWitnessVerified:false,
      evidenceVerified:plan.evidenceVerified,
      snapshotRef:plan.snapshotRef,staleClaimEvents,
      page,pageSize,pages,total,hasMore:page<pages,
      totals,items:items.slice((page-1)*pageSize,page*pageSize),
      notice:'First/second count values are employee declarations. A matching number does not prove physically witnessed inventory, owner approval or safe Woo stock.',
    };
  }
}
