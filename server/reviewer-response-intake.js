import { createHash } from 'node:crypto';
import { z } from 'zod';
import { audit } from './db.js';
import { AppError } from './errors.js';

// Owner-entered claims ABOUT an external review. No external access, no real
// reviewer authentication, no signature check and NO inventory signoff.
const sha=/^[a-f0-9]{64}$/;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const code=/^[A-Za-z0-9][A-Za-z0-9_-]{3,47}$/;
const outcomes=['acknowledgement_reported','discrepancy_reported','review_unavailable'];
const issues=['document_hash_mismatch','signature_missing','count_numbers_conflict',
  'garment_variation_conflict','reviewer_identity_unconfirmed','other_evidence_issue'];
const filters=['all','request_missing','awaiting_external_response',
  'acknowledgement_unverified','reported_discrepancy_open',
  'review_unavailable','custody_or_source_hold'];

export const reviewerResponseSchema=z.object({
  reportRow:z.number().int().min(1).max(10000),
  expectedRef:z.string().regex(sha),
  expectedLatestResponseId:z.number().int().positive().nullable(),
  custodyRequestId:z.number().int().positive(),
  manifestId:z.number().int().positive(),
  fileSha256:z.string().regex(sha),
  firstClaimId:z.number().int().positive(),
  secondClaimId:z.number().int().positive(),
  reviewerCode:z.string().trim().regex(code),
  outcome:z.enum(outcomes),
  issueCode:z.enum(issues).nullable(),
  note:z.string().trim().min(12).max(180)
    .refine(x=>!/[\r\n]/.test(x),'Use a single-line note.'),
  requestId:z.string().regex(uuid),
}).strict().superRefine((x,ctx)=>{
  if((x.outcome==='discrepancy_reported')!==Boolean(x.issueCode))
    ctx.addIssue({code:'custom',path:['issueCode'],
      message:'Only a reported discrepancy may have a specific issue code.'});
});

function readEvents(db){
  const result=[];
  for(const e of db.prepare(
    "SELECT id,actor,subject,created_at FROM audit WHERE action='inventory.external_reviewer_response_claim' ORDER BY id ASC"
  ).all()){
    let x;
    try{x=JSON.parse(e.subject);}catch{continue;}
    if(x?.schemaVersion!==1||!sha.test(x.custodyRef||'')||
       !sha.test(x.sourceHash||'')||!sha.test(x.expectedRef||'')||
       !sha.test(x.fileSha256||'')||
       !Number.isSafeInteger(x.reportRow)||x.reportRow<1||
       !Number.isSafeInteger(x.custodyRequestId)||x.custodyRequestId<1||
       !Number.isSafeInteger(x.manifestId)||x.manifestId<1||
       !Number.isSafeInteger(x.firstClaimId)||x.firstClaimId<1||
       !Number.isSafeInteger(x.secondClaimId)||x.secondClaimId<1||
       !code.test(x.reviewerCode||'')||!outcomes.includes(x.outcome)||
       !(x.issueCode===null||issues.includes(x.issueCode))||
       (x.outcome==='discrepancy_reported')!==Boolean(x.issueCode)||
       typeof x.note!=='string'||x.note.length<12||x.note.length>180||
       !uuid.test(x.requestId||''))continue;
    result.push({...x,id:e.id,actor:e.actor,recordedAt:e.created_at});
  }
  return result;
}
function source(custody,physical,website,clock){
  const rows=[];
  const report=custody.list(physical,website,{page:1,pageSize:1},clock,rows);
  return {report,rows};
}
function latestFor(events,custodyRef,sourceHash){
  const result=new Map();
  for(const x of events){
    if(x.custodyRef===custodyRef&&x.sourceHash===sourceHash)
      result.set(x.reportRow,x);
  }
  return result;
}
function revision(report,rows,latest,sourceHash){
  return createHash('sha256').update(JSON.stringify({
    custodyRef:report.snapshotRef,sourceHash,
    rows:rows.map(x=>({
      row:x.reportRow,sku:x.sku,
      custodyRequestId:x.latestCustodyEvent?.id??null,
      manifestId:x.manifest?.id??null,
      first:x.firstClaimId,second:x.secondClaimId,
      responseId:latest.get(x.reportRow)?.id??null,
    })),
  })).digest('hex');
}
function item(row,event){
  const request=row.latestCustodyEvent;
  const manifest=row.manifest;
  const requestReady=Boolean(row.mayRecord&&manifest&&!manifest.requiresRecheck&&
    request?.action==='independent_review_requested'&&!request.needsRecheck);
  const last=event?{
    id:event.id,reviewerCode:event.reviewerCode,outcome:event.outcome,
    issueCode:event.issueCode,note:event.note,recordedByOwner:event.actor,
    recordedAt:event.recordedAt,
    requiresRecheck:event.custodyRequestId!==request?.id||
      event.manifestId!==manifest?.id||
      event.fileSha256!==manifest?.fileSha256||
      event.firstClaimId!==row.firstClaimId||
      event.secondClaimId!==row.secondClaimId,
    independentlyAuthenticated:false,acknowledgedByReviewerAccount:false,
  }:null;
  let status;
  if(!row.mayRecord||!manifest||manifest.requiresRecheck)
    status='custody_or_source_hold';
  else if(!requestReady)status='request_missing';
  else if(last?.requiresRecheck)status='awaiting_external_response';
  else if(!last)status='awaiting_external_response';
  else if(last.outcome==='discrepancy_reported')status='reported_discrepancy_open';
  else if(last.outcome==='review_unavailable')status='review_unavailable';
  else status='acknowledgement_unverified';
  return {
    reportRow:row.reportRow,sku:row.sku,
    custodyRequestId:requestReady?request.id:null,
    manifestId:manifest?.id??null,
    fileSha256:manifest?.fileSha256??null,
    firstClaimId:row.firstClaimId,
    secondClaimId:row.secondClaimId,
    countDiscrepancyOpen:row.countDiscrepancyOpen,
    latestResponse:last,status,mayReport:requestReady,
    independentReviewConfirmed:false,documentAuthenticityVerified:false,
    countsVerified:false,stockImportAuthorized:false,checkoutAuthorized:false,
  };
}
export class ReviewerResponseIntake{
  constructor(db,custody){
    this.db=db;this.custody=custody;
  }
  list(physical,website,query={},clock=Date.now()){
    const {page=1,pageSize=25,status='all',search=''}=query;
    if(!Number.isSafeInteger(page)||page<1||page>10000||
       !Number.isSafeInteger(pageSize)||pageSize<1||pageSize>50||
       !filters.includes(status)||typeof search!=='string'||search.length>64)
      throw new AppError('Invalid reviewer intake filters.',400,
        'REVIEWER_INTAKE_INVALID_FILTER');
    const {report,rows}=source(this.custody,physical,website,clock);
    const latest=latestFor(readEvents(this.db),report.snapshotRef,physical?.manifestHash);
    const snapshotRef=revision(report,rows,latest,physical?.manifestHash);
    const all=rows.map(x=>item(x,latest.get(x.reportRow)));
    const stats={
      awaitingReports:all.filter(x=>x.status==='awaiting_external_response').length,
      ownerReportedAcknowledgements:all.filter(x=>x.status==='acknowledgement_unverified').length,
      reportedDiscrepancies:all.filter(x=>x.status==='reported_discrepancy_open').length,
      openStaffCountDiscrepancies:all.filter(x=>x.countDiscrepancyOpen).length,
      independentlyAuthenticatedReviewers:0,
    };
    const term=search.trim().toUpperCase();
    const selected=all.filter(x=>(status==='all'||x.status===status)&&(
      !term||x.sku.toUpperCase().includes(term)||
      String(x.reportRow).includes(term)||
      String(x.latestResponse?.reviewerCode||'').toUpperCase().includes(term)));
    const total=selected.length,pages=Math.max(1,Math.ceil(total/pageSize));
    return {
      kind:'owner-reported-external-reviewer-intake',auditOnly:true,
      evidenceVerified:report.evidenceVerified,
      snapshotRef,custodyRef:report.snapshotRef,
      sourceHash:physical?.manifestHash,
      stats,
      externalReviewerLoginAvailable:false,reviewerIdentityVerified:false,
      independentReviewConfirmed:false,documentSignatureVerified:false,
      independentWitnessVerified:false,ownerApproved:false,
      mappingApproved:false,sharedStockVerified:false,
      stockImportAuthorized:false,checkoutAuthorized:false,
      page,pageSize,pages,total,hasMore:page<pages,
      items:selected.slice((page-1)*pageSize,page*pageSize),
      notice:'Owner-reported reviewer messages are not acknowledgements by a logged-in reviewer. No reviewer received a file through this app and no witness, document, count or stock is verified.',
    };
  }
  submit(user,physical,website,raw,clock=Date.now()){
    if(user?.role!=='owner')
      throw new AppError('Only the Owner may record an external review response claim.',403,
        'REVIEWER_INTAKE_OWNER_ONLY');
    const data=reviewerResponseSchema.parse(raw);
    const {report,rows}=source(this.custody,physical,website,clock);
    if(!report.evidenceVerified||!sha.test(physical?.manifestHash||''))
      throw new AppError('Historical source or Woo published identity is stale.',409,
        'REVIEWER_INTAKE_EVIDENCE_STALE');
    if(rows.filter(r=>r.reportRow===data.reportRow).length!==1)
      throw new AppError('Historical inventory row missing or duplicated.',409,
        'REVIEWER_INTAKE_ROW_AMBIGUOUS');
    // This is only a string collision check, NOT identity authentication.
    // The external reviewer is not provisioned as a POS employee.
    const counterRows=[];
    this.custody.fileManifests.supervision.countClaims.ownerReview(
      physical,website,{page:1,pageSize:1},clock,counterRows);
    const counters=counterRows.find(x=>x.reportRow===data.reportRow);
    if(!counters||!counters.firstActor||!counters.secondActor)
      throw new AppError('Two distinguishable staff declarations are required.',409,
        'REVIEWER_INTAKE_COUNTERS_MISSING');
    const claimed=data.reviewerCode.toLowerCase();
    if([user.id,counters.firstActor,counters.secondActor].some(x=>
      typeof x==='string'&&x.toLowerCase()===claimed))
      throw new AppError('Reviewer reference duplicates the Owner or an assigned counter account.',409,
        'REVIEWER_INTAKE_REFERENCE_NOT_DISTINCT');
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const events=readEvents(this.db);
      const replay=events.find(x=>x.requestId===data.requestId);
      if(replay){
        const same=replay.actor===user.id&&
          replay.sourceHash===physical.manifestHash&&
          replay.custodyRef===report.snapshotRef&&
          replay.expectedRef===data.expectedRef&&
          replay.reportRow===data.reportRow&&
          replay.custodyRequestId===data.custodyRequestId&&
          replay.manifestId===data.manifestId&&
          replay.fileSha256===data.fileSha256&&
          replay.firstClaimId===data.firstClaimId&&
          replay.secondClaimId===data.secondClaimId&&
          replay.reviewerCode===data.reviewerCode&&
          replay.outcome===data.outcome&&
          replay.issueCode===data.issueCode&&
          replay.note===data.note;
        if(!same)throw new AppError('Reviewer request UUID reused with different evidence.',409,
          'REVIEWER_INTAKE_REPLAY_CONFLICT');
        this.db.exec('COMMIT');
        return {
          kind:'unverified-owner-reported-reviewer-response',recorded:true,
          replayed:true,eventId:replay.id,auditOnly:true,
          reviewerIdentityVerified:false,independentReviewConfirmed:false,
          ownerApproved:false,stockImportAuthorized:false,checkoutAuthorized:false,
        };
      }
      const current=source(this.custody,physical,website,clock);
      const currentLatest=latestFor(events,current.report.snapshotRef,
        physical.manifestHash);
      const ref=revision(current.report,current.rows,currentLatest,physical.manifestHash);
      if(ref!==data.expectedRef)
        throw new AppError('Review request or submitted evidence changed; reload review.',409,
          'REVIEWER_INTAKE_SNAPSHOT_CHANGED');
      const row=current.rows.find(x=>x.reportRow===data.reportRow);
      const currentItem=row&&item(row,currentLatest.get(data.reportRow));
      if(!currentItem||!currentItem.mayReport||
         currentItem.custodyRequestId!==data.custodyRequestId||
         currentItem.manifestId!==data.manifestId||
         currentItem.fileSha256!==data.fileSha256||
         currentItem.firstClaimId!==data.firstClaimId||
         currentItem.secondClaimId!==data.secondClaimId)
        throw new AppError('No current external review request is linked to these counts and file.',409,
          'REVIEWER_INTAKE_REQUEST_CHANGED');
      const previous=currentLatest.get(data.reportRow);
      if(data.expectedLatestResponseId!==(previous?.id??null))
        throw new AppError('A newer reviewer response claim exists; reload the case.',409,
          'REVIEWER_INTAKE_NEWER_RESPONSE');
      audit(this.db,user.id,'inventory.external_reviewer_response_claim',JSON.stringify({
        schemaVersion:1,sourceHash:physical.manifestHash,
        custodyRef:current.report.snapshotRef,expectedRef:data.expectedRef,
        reportRow:data.reportRow,custodyRequestId:data.custodyRequestId,
        manifestId:data.manifestId,fileSha256:data.fileSha256,
        firstClaimId:data.firstClaimId,secondClaimId:data.secondClaimId,
        reviewerCode:data.reviewerCode,outcome:data.outcome,
        issueCode:data.issueCode,note:data.note,requestId:data.requestId,
      }));
      const e=this.db.prepare(
        "SELECT id FROM audit WHERE action='inventory.external_reviewer_response_claim' ORDER BY id DESC LIMIT 1"
      ).get();
      this.db.exec('COMMIT');
      return {
        kind:'unverified-owner-reported-reviewer-response',recorded:true,
        replayed:false,eventId:e.id,auditOnly:true,
        reviewerIdentityVerified:false,independentReviewConfirmed:false,
        ownerApproved:false,stockImportAuthorized:false,checkoutAuthorized:false,
      };
    }catch(err){
      this.db.exec('ROLLBACK');
      throw err;
    }
  }
}
