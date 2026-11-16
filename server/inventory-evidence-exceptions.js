import { createHash } from 'node:crypto';
import { z } from 'zod';
import { audit } from './db.js';
import { AppError } from './errors.js';

// Phase 5.6: an Owner-only, append-only INVESTIGATION register.
// It must never issue an inventory approval, close a discrepancy, or trade.
const sha=/^[a-f0-9]{64}$/;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const actions=[
  'request_independent_recount',
  'inspect_original_outside_pos',
  'investigate_sku_variation',
  'request_replacement_evidence',
  'verify_reviewer_identity_offline',
  'escalate_for_independent_audit',
];
const statuses=['all','count_disagreement','reviewer_evidence_issue',
  'handoff_action_needed','custody_or_source_hold','other_unverified'];
const locked=Object.freeze({
  auditOnly:true,caseClosed:false,inventoryAccepted:false,
  independentReviewConfirmed:false,reviewerIdentityVerified:false,
  physicalCountVerified:false,signatureVerified:false,
  mappingApproved:false,ownerApproved:false,sharedStockVerified:false,
  stockImportAuthorized:false,checkoutAuthorized:false,paymentsAuthorized:false,
});
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const evidenceExceptionFollowupSchema=z.object({
  reportRow:z.number().int().min(1).max(10000),
  expectedRef:z.string().regex(sha),
  expectedCaseRef:z.string().regex(sha),
  expectedLatestEventId:z.number().int().positive().nullable(),
  action:z.enum(actions),
  note:z.string().trim().min(12).max(180).refine(x=>!/[\r\n]/.test(x)),
  requestId:z.string().regex(uuid),
}).strict();

function ownerOnly(user){
  if(user?.role!=='owner')
    throw new AppError('Only the Owner can record evidence investigation follow-ups.',403,
      'EVIDENCE_EXCEPTION_OWNER_ONLY');
}
function readEvents(db){
  const rows=db.prepare(
    "SELECT id,actor,subject,created_at FROM audit WHERE action='inventory.evidence_exception_followup' ORDER BY id ASC"
  ).all();
  const result=[];
  for(const r of rows){
    let x;
    try{x=JSON.parse(r.subject);}catch{continue;}
    if(x?.schemaVersion!==1||!sha.test(x.caseKey||'')||
      !sha.test(x.expectedCaseRef||'')||!sha.test(x.expectedRef||'')||
      !uuid.test(x.requestId||'')||!Number.isSafeInteger(x.reportRow)||
      x.reportRow<1||!actions.includes(x.action)||
      typeof x.note!=='string'||x.note.length<12||x.note.length>180||
      /[\r\n]/.test(x.note)||
      !(x.expectedLatestEventId===null||
        Number.isSafeInteger(x.expectedLatestEventId)&&x.expectedLatestEventId>0))continue;
    result.push({...x,id:r.id,actor:r.actor,recordedAt:r.created_at});
  }
  return result;
}
function classify(row,assignments){
  const flags=new Set();
  if(row.countDiscrepancyOpen)flags.add('staff_count_disagreement');
  if(!row.mayReport)flags.add('custody_or_source_not_ready');
  if(row.status==='reported_discrepancy_open')
    flags.add('owner_reported_discrepancy_unverified');
  if(row.status==='review_unavailable')
    flags.add('owner_reported_review_unavailable');
  const current=assignments.filter(x=>x.status==='assigned_metadata_only');
  if(!current.length)flags.add('authenticated_reviewer_missing');
  if(assignments.some(x=>x.status==='revoked'||x.status==='stale_evidence'))
    flags.add('reviewer_grant_revoked_or_stale');
  for(const a of current){
    if(a.latestAcknowledgement?.outcome==='evidence_issue_reported')
      flags.add('reviewer_account_reported_issue');
    if(a.latestAcknowledgement?.outcome==='unable_to_review')
      flags.add('reviewer_account_unavailable');
    const h=a.handoff;
    if(['not_issued','awaiting_challenge','expired','inactive_or_stale'].includes(h?.status??'not_issued'))
      flags.add('handoff_not_confirmed');
    if(h?.receipt?.observation==='file_not_available')
      flags.add('file_not_available_reported');
    if(h?.receipt?.observation==='fingerprint_mismatch_reported')
      flags.add('fingerprint_mismatch_reported');
    if(h?.receipt?.observation==='fingerprint_match_reported')
      flags.add('fingerprint_match_not_provenance');
  }
  if(flags.size===0)flags.add('independent_verification_missing');
  const issues=[...flags];
  const category=row.countDiscrepancyOpen?'count_disagreement':
    issues.some(x=>['owner_reported_discrepancy_unverified','reviewer_account_reported_issue',
      'file_not_available_reported','fingerprint_mismatch_reported'].includes(x))
      ?'reviewer_evidence_issue':
    !row.mayReport?'custody_or_source_hold':
    issues.includes('handoff_not_confirmed')||issues.includes('authenticated_reviewer_missing')
      ?'handoff_action_needed':'other_unverified';
  return {flags:issues,category};
}
function prepare(db,intake,access,user,physical,website,clock){
  ownerOnly(user);
  const rows=[];
  const report=intake.list(physical,website,{page:1,pageSize:1},clock,rows);
  if(report.evidenceVerified!==true||!sha.test(report.snapshotRef||'')||
     !sha.test(physical?.manifestHash||''))
    throw new AppError('Historical physical source or website evidence is stale.',409,
      'EVIDENCE_EXCEPTION_SOURCE_STALE');
  const reviewer=access.listOwner(user,physical,website,clock);
  if(reviewer.snapshotRef!==report.snapshotRef||
     reviewer.stockImportAuthorized!==false||
     reviewer.checkoutAuthorized!==false||
     !Array.isArray(reviewer.assignments))
    throw new AppError('Reviewer evidence and source snapshot disagree.',409,
      'EVIDENCE_EXCEPTION_REVIEWER_STALE');
  const journal=readEvents(db);
  const cases=rows.map(row=>{
    const assignments=reviewer.assignments.filter(x=>x.reportRow===row.reportRow);
    const {flags,category}=classify(row,assignments);
    const caseKey=digest({
      schemaVersion:1,sourceHash:physical.manifestHash,
      intakeRef:report.snapshotRef,reportRow:row.reportRow,
      sku:row.sku,custodyRequestId:row.custodyRequestId,
      manifestId:row.manifestId,fileSha256:row.fileSha256,
      firstClaimId:row.firstClaimId,secondClaimId:row.secondClaimId,
      countDiscrepancyOpen:row.countDiscrepancyOpen,
      intakeStatus:row.status,intakeResponse:row.latestResponse,
      assignments:assignments.map(x=>({
        grantId:x.grantId,reviewerId:x.reviewerId,
        status:x.status,handoff:x.handoff,latestAcknowledgement:x.latestAcknowledgement,
      })),
    });
    const related=journal.filter(e=>e.reportRow===row.reportRow);
    const latest=related.filter(e=>e.caseKey===caseKey).at(-1)||null;
    const latestFollowup=latest?{
      id:latest.id,action:latest.action,note:latest.note,
      recordedByAccount:latest.actor,recordedAt:latest.recordedAt,
    }:null;
    const caseRef=digest({caseKey,latestFollowupId:latest?.id??null});
    return {
      reportRow:row.reportRow,sku:row.sku,caseKey,caseRef,
      category,flags,countDiscrepancyOpen:Boolean(row.countDiscrepancyOpen),
      latestFollowup,historicalFollowupCount:related.length,
      reviewerAssignments:assignments.map(x=>({
        grantId:x.grantId,status:x.status,
        handoffStatus:x.handoff?.status??'not_issued',
        receiptObservation:x.status==='assigned_metadata_only'?
          x.handoff?.receipt?.observation??null:null,
        reviewerResponse:x.status==='assigned_metadata_only'?
          x.latestAcknowledgement?.outcome??null:null,
        independentlyAuthenticatedHuman:false,
      })),
      caseClosed:false,inventoryAccepted:false,
    };
  });
  const snapshotRef=digest({schemaVersion:1,sourceHash:physical.manifestHash,
    intakeRef:report.snapshotRef,
    cases:cases.map(x=>({reportRow:x.reportRow,caseRef:x.caseRef}))});
  return {snapshotRef,cases,journal};
}
export class InventoryEvidenceExceptionReview{
  constructor(db,intake,reviewerAccess){
    this.db=db;this.intake=intake;this.reviewerAccess=reviewerAccess;
  }
  list(user,physical,website,raw={},clock=Date.now()){
    ownerOnly(user);
    const input=z.object({
      page:z.number().int().min(1).max(10000).default(1),
      pageSize:z.number().int().min(1).max(50).default(25),
      status:z.enum(statuses).default('all'),
      search:z.string().trim().max(64).default(''),
    }).strict().parse(raw);
    const {snapshotRef,cases}=prepare(this.db,this.intake,this.reviewerAccess,
      user,physical,website,clock);
    const term=input.search.toUpperCase();
    const filtered=cases.filter(x=>(input.status==='all'||x.category===input.status)&&
      (!term||String(x.sku).toUpperCase().includes(term)||
      String(x.reportRow).includes(term)));
    const pages=Math.max(1,Math.ceil(filtered.length/input.pageSize));
    return {
      kind:'owner-inventory-evidence-exception-queue',snapshotRef,
      page:input.page,pageSize:input.pageSize,total:filtered.length,pages,
      categories:statuses,
      summary:{
        totalCases:cases.length,
        staffCountDisagreements:cases.filter(x=>x.countDiscrepancyOpen).length,
        reviewerEvidenceIssues:cases.filter(x=>x.category==='reviewer_evidence_issue').length,
        awaitingHandoff:cases.filter(x=>x.category==='handoff_action_needed').length,
        independentlyVerifiedCases:0,approvedCases:0,
      },
      items:filtered.slice((input.page-1)*input.pageSize,input.page*input.pageSize)
        .map(item=>{const safe={...item};delete safe.caseKey;return safe;}),
      ...locked,
      notice:'All physical stock remains unverified. Owner investigation notes cannot close a count dispute, approve inventory or release checkout.',
    };
  }
  followup(user,physical,website,raw,clock=Date.now()){
    ownerOnly(user);
    const input=evidenceExceptionFollowupSchema.parse(raw);
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const journal=readEvents(this.db);
      const replay=journal.find(e=>e.requestId===input.requestId);
      if(replay){
        if(replay.actor!==user.id||replay.expectedRef!==input.expectedRef||
          replay.expectedCaseRef!==input.expectedCaseRef||
          replay.expectedLatestEventId!==input.expectedLatestEventId||
          replay.reportRow!==input.reportRow||replay.action!==input.action||
          replay.note!==input.note)
          throw new AppError('Follow-up UUID reused with different evidence.',409,
            'EVIDENCE_EXCEPTION_REPLAY_CONFLICT');
        this.db.exec('COMMIT');
        return {kind:'owner-evidence-investigation-followup',eventId:replay.id,
          recorded:true,replayed:true,...locked};
      }
      const {snapshotRef,cases}=prepare(this.db,this.intake,this.reviewerAccess,
        user,physical,website,clock);
      if(snapshotRef!==input.expectedRef)
        throw new AppError('Underlying evidence or investigation journal changed.',409,
          'EVIDENCE_EXCEPTION_SNAPSHOT_CHANGED');
      const found=cases.filter(x=>x.reportRow===input.reportRow);
      if(found.length!==1||found[0].caseRef!==input.expectedCaseRef)
        throw new AppError('Selected case was modified or superseded.',409,
          'EVIDENCE_EXCEPTION_CASE_CHANGED');
      const selected=found[0];
      if(input.expectedLatestEventId!==(selected.latestFollowup?.id??null))
        throw new AppError('Another follow-up was recorded first.',409,
          'EVIDENCE_EXCEPTION_NEWER_FOLLOWUP');
      audit(this.db,user.id,'inventory.evidence_exception_followup',JSON.stringify({
        schemaVersion:1,
        caseKey:selected.caseKey,
        expectedCaseRef:input.expectedCaseRef,
        expectedRef:input.expectedRef,
        expectedLatestEventId:input.expectedLatestEventId,
        reportRow:input.reportRow,
        action:input.action,note:input.note,requestId:input.requestId,
      }));
      const eventId=this.db.prepare(
        "SELECT id FROM audit WHERE action='inventory.evidence_exception_followup' ORDER BY id DESC LIMIT 1"
      ).get().id;
      this.db.exec('COMMIT');
      return {kind:'owner-evidence-investigation-followup',eventId,
        recorded:true,replayed:false,...locked};
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
}
