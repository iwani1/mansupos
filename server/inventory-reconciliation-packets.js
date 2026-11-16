import {createHash} from 'node:crypto';
import {z} from 'zod';
import {audit} from './db.js';
import {AppError} from './errors.js';
import {buildInventoryVerificationReadiness} from './inventory-verification-readiness.js';

// Phase 5.8: provisional reconciliation proposals + independent account
// CHALLENGE statements. No human identity proof, inventory approval,
// WooCommerce write, payment, checkout or physical count attestation.
const sha=/^[a-f0-9]{64}$/;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const intents=['request_blind_recount','inspect_original_count_document',
  'investigate_product_variation','prepare_provisional_count'];
const responses=['requires_independent_recount','original_document_unavailable',
  'product_variation_uncertain','witness_identity_not_proven','other_evidence_problem'];
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const locked=Object.freeze({
  auditOnly:true,provisionalOnly:true,humanIdentityVerified:false,
  independentWitnessVerified:false,originalDocumentVerified:false,
  physicalCountVerified:false,reconciliationApproved:false,
  discrepancyClosed:false,mappingApproved:false,ownerApproved:false,
  inventoryAccepted:false,acceptanceCertificateIssued:false,
  stockImportAuthorized:false,checkoutAuthorized:false,
  paymentsAuthorized:false,releaseReady:false,
});
const ownerSchema=z.object({
  reportRow:z.number().int().min(1).max(10000),
  grantId:z.number().int().positive(),
  expectedReadinessRef:z.string().regex(sha),
  expectedRowEvidenceRef:z.string().regex(sha),
  expectedLatestPacketId:z.number().int().positive().nullable(),
  intent:z.enum(intents),
  proposedUnits:z.number().int().min(0).max(1000000).nullable(),
  note:z.string().trim().min(12).max(180).refine(x=>!/[\r\n]/.test(x)),
  requestId:z.string().regex(uuid),
}).strict().superRefine((x,ctx)=>{
  if((x.intent==='prepare_provisional_count')!==(x.proposedUnits!==null))
    ctx.addIssue({code:'custom',path:['proposedUnits'],
      message:'Provisional units are allowed only for a provisional-count plan.'});
});
const reviewerSchema=z.object({
  packetId:z.number().int().positive(),
  expectedReviewerRef:z.string().regex(sha),
  finding:z.enum(responses),
  note:z.string().trim().min(12).max(180).refine(x=>!/[\r\n]/.test(x)),
  requestId:z.string().regex(uuid),
}).strict();
function ownerOnly(user){
  if(user?.role!=='owner')throw new AppError('Only the Owner can prepare reconciliation packets.',403,
    'RECONCILIATION_OWNER_ONLY');
}
function reviewerOnly(user){
  if(user?.role!=='reviewer')throw new AppError('Only dedicated reviewer accounts can report packet issues.',403,
    'RECONCILIATION_REVIEWER_ONLY');
}
function events(db,action){
  const rows=db.prepare('SELECT id,actor,subject,created_at FROM audit WHERE action=? ORDER BY id ASC').all(action);
  const result=[];
  for(const r of rows){
    let d;
    try{d=JSON.parse(r.subject);}catch{continue;}
    if(d?.schemaVersion!==1||!uuid.test(d.requestId||'')||
       !Number.isSafeInteger(d.grantId)||d.grantId<1||
       !Number.isSafeInteger(d.reportRow)||d.reportRow<1)continue;
    if(action==='inventory.reconciliation_packet_proposed'){
      if(!Number.isSafeInteger(d.reviewerId)||!sha.test(d.readinessRef||'')||
         !sha.test(d.rowEvidenceRef||'')||!sha.test(d.reviewerRef||'')||
         !sha.test(d.sourceHash||'')||!sha.test(d.fileSha256||'')||
         !intents.includes(d.intent)||
         !(d.proposedUnits===null||Number.isSafeInteger(d.proposedUnits)&&d.proposedUnits>=0&&d.proposedUnits<=1000000)||
         typeof d.note!=='string')continue;
    }else if(action==='inventory.reconciliation_packet_reviewed'){
      if(!Number.isSafeInteger(d.packetId)||d.packetId<1||
         !sha.test(d.expectedReviewerRef||'')||!responses.includes(d.finding)||
         typeof d.note!=='string')continue;
    }
    result.push({...d,id:r.id,actor:r.actor,recordedAt:r.created_at});
  }
  return result;
}
function packetHistory(db){
  // Separate decoder permits UUID reviewer user IDs, not POS integer IDs.
  const rows=db.prepare("SELECT id,actor,subject,created_at FROM audit WHERE action='inventory.reconciliation_packet_proposed' ORDER BY id ASC").all();
  return rows.flatMap(r=>{
    let d;try{d=JSON.parse(r.subject);}catch{return [];}
    if(d?.schemaVersion!==1||!uuid.test(d.requestId||'')||
      !uuid.test(d.reviewerId||'')||
      !sha.test(d.readinessRef||'')||!sha.test(d.rowEvidenceRef||'')||
      !sha.test(d.reviewerRef||'')||!sha.test(d.sourceHash||'')||
      !sha.test(d.fileSha256||'')||
      !Number.isSafeInteger(d.grantId)||d.grantId<1||
      !Number.isSafeInteger(d.reportRow)||d.reportRow<1||
      !intents.includes(d.intent)||
      !(d.proposedUnits===null||
        Number.isSafeInteger(d.proposedUnits)&&d.proposedUnits>=0&&d.proposedUnits<=1000000)||
      (d.intent==='prepare_provisional_count')!==(d.proposedUnits!==null)||
      typeof d.note!=='string'||d.note.length<12||d.note.length>180||
      /[\r\n]/.test(d.note))return [];
    return [{...d,id:r.id,actor:r.actor,recordedAt:r.created_at}];
  });
}
function reviewerHistory(db){
  return events(db,'inventory.reconciliation_packet_reviewed').filter(x=>
    uuid.test(x.reviewerId||'')&&Number.isSafeInteger(x.packetId)&&x.packetId>0&&
    sha.test(x.expectedReviewerRef||'')&&responses.includes(x.finding)&&
    x.note.length>=12&&x.note.length<=180&&!/[\r\n]/.test(x.note));
}
function latestPacket(history,grantId){
  return history.filter(x=>x.grantId===grantId).at(-1)||null;
}
function latestResponse(history,packetId){
  return history.find(x=>x.packetId===packetId)||null;
}
function addEvent(db,user,action,payload){
  audit(db,user.id,action,JSON.stringify({schemaVersion:1,...payload}));
  return db.prepare('SELECT id FROM audit WHERE action=? ORDER BY id DESC LIMIT 1').get(action).id;
}
const internalEvidenceChecker=Object.freeze({id:'internal-readonly-guard',role:'owner'});
export class InventoryReconciliationPackets{
  constructor(db,mappingEvidence,countClaims,exceptions,reviewerAccess){
    this.db=db;this.mappingEvidence=mappingEvidence;
    this.countClaims=countClaims;this.exceptions=exceptions;
    this.reviewerAccess=reviewerAccess;
  }
  readiness(user,physical,website,clock){
    const rows=[];
    const report=buildInventoryVerificationReadiness(physical,website,
      this.mappingEvidence,this.countClaims,this.exceptions,user,
      {page:1,pageSize:1},clock,rows);
    if(report.stockImportAuthorized!==false||report.checkoutAuthorized!==false||
       report.inventoryAccepted!==false||report.releaseReady!==false||
       !sha.test(report.readinessRef)||rows.length!==report.summary.totalHistoricalRows)
      throw new AppError('Inventory readiness is incomplete or unsafe.',409,
        'RECONCILIATION_READINESS_UNSAFE');
    return {report,rows};
  }
  ownerContext(user,physical,website,clock){
    ownerOnly(user);
    const state=this.readiness(user,physical,website,clock);
    const access=this.reviewerAccess.listOwner(user,physical,website,clock);
    if(access.stockImportAuthorized!==false||access.checkoutAuthorized!==false||
       !sha.test(access.snapshotRef)||!Array.isArray(access.assignments))
      throw new AppError('Reviewer access evidence is incomplete.',409,
        'RECONCILIATION_GRANT_EVIDENCE_STALE');
    return {...state,access};
  }
  currentPacket(packet,row,grant,ctx){
    return Boolean(packet&&row&&grant&&
      packet.readinessRef===ctx.report.readinessRef&&
      packet.rowEvidenceRef===row.evidenceRef&&
      packet.sourceHash===ctx.report.sourceHash&&
      packet.reviewerRef===ctx.access.snapshotRef&&
      packet.grantId===grant.grantId&&
      packet.reviewerId===grant.reviewerId&&
      packet.reportRow===row.reportRow&&
      packet.fileSha256===grant.fileSha256&&
      grant.status==='assigned_metadata_only'&&
      ctx.access.accounts.some(a=>a.id===packet.reviewerId&&a.active));
  }
  listOwner(user,physical,website,options={},clock=Date.now(),collectRows=null){
    ownerOnly(user);
    const parsed=z.object({
      page:z.number().int().min(1).max(10000).default(1),
      pageSize:z.number().int().min(1).max(50).default(25),
      search:z.string().trim().max(64).default(''),
    }).strict().parse(options);
    const ctx=this.ownerContext(user,physical,website,clock);
    const history=packetHistory(this.db),responseHistory=reviewerHistory(this.db);
    const items=ctx.rows.map(row=>{
      const grants=ctx.access.assignments.filter(g=>g.reportRow===row.reportRow);
      const latest=history.filter(p=>p.reportRow===row.reportRow).at(-1)||null;
      const selected=grants.find(g=>g.grantId===latest?.grantId)||null;
      const current=this.currentPacket(latest,row,selected,ctx);
      const response=latest&&latestResponse(responseHistory,latest.id);
      return {
        reportRow:row.reportRow,sku:row.sku,
        priority:row.priority,readiness:'blocked',
        rowEvidenceRef:row.evidenceRef,
        countDiscrepancyOpen:row.staffCountDiscrepancyOpen,
        availableGrants:grants.filter(g=>g.status==='assigned_metadata_only'&&
          ctx.access.accounts.some(a=>a.id===g.reviewerId&&a.active)).map(g=>({
          grantId:g.grantId,reviewerId:g.reviewerId,
          username:ctx.access.accounts.find(a=>a.id===g.reviewerId)?.username,
        })),
        latestPacket:latest?{
          id:latest.id,grantId:latest.grantId,intent:latest.intent,
          proposedUnits:latest.proposedUnits,note:latest.note,
          status:current?'provisional_under_account_review':'stale_evidence',
          recordedAt:latest.recordedAt,
          latestResponse:response?{
            id:response.id,finding:response.finding,note:response.note,
            recordedAt:response.recordedAt,
            accountAuthenticated:true,humanWitnessVerified:false,
          }:null,
        }:null,
        independentWitnessVerified:false,reconciliationApproved:false,
        stockImportAuthorized:false,
      };
    });
    if(Array.isArray(collectRows))collectRows.push(...items);
    const q=parsed.search.trim().toUpperCase();
    const filtered=items.filter(r=>!q||r.sku.toUpperCase().includes(q)||
      String(r.reportRow).includes(q));
    const snapshotRef=hash({
      readinessRef:ctx.report.readinessRef,reviewerRef:ctx.access.snapshotRef,
      packets:history.map(p=>[p.id,p.reportRow,p.grantId]),
      responses:responseHistory.map(r=>[r.id,r.packetId]),
    });
    const total=filtered.length,pages=Math.max(1,Math.ceil(total/parsed.pageSize));
    return {
      kind:'owner-provisional-reconciliation-register',
      snapshotRef,readinessRef:ctx.report.readinessRef,
      reviewerRef:ctx.access.snapshotRef,
      page:parsed.page,pageSize:parsed.pageSize,pages,total,
      items:filtered.slice((parsed.page-1)*parsed.pageSize,parsed.page*parsed.pageSize),
      summary:{
        historicalRows:ctx.rows.length,
        provisionalProposals:history.length,
        accountReportedIssues:responseHistory.length,
        approvedReconciliations:0,acceptedUnits:0,
      },
      ...locked,
      notice:'An Owner proposed count is NOT a validated physical count. Account reviewer responses are NOT identity proof or independent witness certification. Stock remains locked.',
    };
  }
  propose(user,physical,website,raw,clock=Date.now()){
    ownerOnly(user);
    const data=ownerSchema.parse(raw);
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const history=packetHistory(this.db);
      const replay=history.find(x=>x.requestId===data.requestId);
      if(replay){
        if(replay.actor!==user.id||replay.reportRow!==data.reportRow||
           replay.grantId!==data.grantId||
           replay.readinessRef!==data.expectedReadinessRef||
           replay.rowEvidenceRef!==data.expectedRowEvidenceRef||
           replay.expectedLatestPacketId!==data.expectedLatestPacketId||
           replay.intent!==data.intent||replay.proposedUnits!==data.proposedUnits||
           replay.note!==data.note)
          throw new AppError('Reconciliation UUID reused with changed contents.',409,
            'RECONCILIATION_PROPOSAL_REPLAY_CONFLICT');
        this.db.exec('COMMIT');
        return {kind:'owner-unverified-reconciliation-proposal',packetId:replay.id,
          replayed:true,...locked};
      }
      const ctx=this.ownerContext(user,physical,website,clock);
      if(ctx.report.readinessRef!==data.expectedReadinessRef)
        throw new AppError('Inventory readiness changed. Refresh the case.',409,
          'RECONCILIATION_READINESS_CHANGED');
      const rows=ctx.rows.filter(x=>x.reportRow===data.reportRow);
      if(rows.length!==1||rows[0].evidenceRef!==data.expectedRowEvidenceRef)
        throw new AppError('Inventory row evidence changed.',409,'RECONCILIATION_ROW_CHANGED');
      const grants=ctx.access.assignments.filter(g=>g.grantId===data.grantId&&
        g.reportRow===data.reportRow&&g.status==='assigned_metadata_only'&&
        ctx.access.accounts.some(a=>a.id===g.reviewerId&&a.active));
      if(grants.length!==1)
        throw new AppError('An active reviewer assignment is required.',409,
          'RECONCILIATION_GRANT_REQUIRED');
      const last=history.filter(p=>p.reportRow===data.reportRow).at(-1)||null;
      if(data.expectedLatestPacketId!==(last?.id??null))
        throw new AppError('A newer Owner reconciliation proposal exists.',409,
          'RECONCILIATION_NEWER_PACKET');
      const grant=grants[0];
      const id=addEvent(this.db,user,'inventory.reconciliation_packet_proposed',{
        ...data,readinessRef:data.expectedReadinessRef,
        rowEvidenceRef:data.expectedRowEvidenceRef,
        sourceHash:ctx.report.sourceHash,reviewerRef:ctx.access.snapshotRef,
        reviewerId:grant.reviewerId,
        custodyRequestId:grant.custodyRequestId,
        fileSha256:grant.fileSha256,
      });
      this.db.exec('COMMIT');
      return {kind:'owner-unverified-reconciliation-proposal',packetId:id,
        replayed:false,...locked};
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  reviewerContext(user,physical,website,clock){
    reviewerOnly(user);
    const assigned=this.reviewerAccess.listAssigned(user,physical,website,clock);
    if(!sha.test(assigned.snapshotRef)||assigned.stockImportAuthorized!==false||
      assigned.checkoutAuthorized!==false||!Array.isArray(assigned.cases))
      throw new AppError('Current reviewer grants are not safe.',409,
        'RECONCILIATION_REVIEWER_ACCESS_UNSAFE');
    // Internal verifier executes ONLY to detect stale Owner mapping/count
    // evidence. Its results are never exposed through reviewer endpoints.
    const readiness=this.readiness(internalEvidenceChecker,physical,website,clock);
    return {assigned,readiness};
  }
  visiblePacket(packet,ctx,user,history){
    const grant=ctx.assigned.cases.find(g=>g.grantId===packet.grantId&&
      g.reportRow===packet.reportRow&&g.status==='assigned_metadata_only'&&
      g.mayAcknowledge===true&&g.fileSha256===packet.fileSha256&&
      g.custodyRequestId===packet.custodyRequestId);
    const row=ctx.readiness.rows.find(r=>r.reportRow===packet.reportRow);
    return packet.reviewerId===user.id&&grant&&row&&
      packet.readinessRef===ctx.readiness.report.readinessRef&&
      packet.rowEvidenceRef===row.evidenceRef&&
      packet.reviewerRef===ctx.assigned.snapshotRef&&
      packet.sourceHash===ctx.readiness.report.sourceHash&&
      latestPacket(history,packet.grantId)?.id===packet.id&&
      history.filter(p=>p.reportRow===packet.reportRow).at(-1)?.id===packet.id;
  }
  listReviewer(user,physical,website,clock=Date.now()){
    const ctx=this.reviewerContext(user,physical,website,clock);
    const history=packetHistory(this.db),responses=reviewerHistory(this.db);
    const items=history.filter(packet=>this.visiblePacket(packet,ctx,user,history))
      .map(packet=>{
        const response=latestResponse(responses,packet.id);
        return {
          packetId:packet.id,grantId:packet.grantId,
          reportRow:packet.reportRow,
          intent:packet.intent,
          status:response?'account_issue_reported':'awaiting_account_evidence_issue',
          latestResponse:response?{
            id:response.id,finding:response.finding,
            note:response.note,recordedAt:response.recordedAt,
          }:null,
          // No provisional count, original file or private Owner note.
          humanIdentityVerified:false,independentWitnessVerified:false,
          reconciliationApproved:false,inventoryAccepted:false,
        };
      });
    return {
      kind:'reviewer-provisional-reconciliation-metadata',
      reviewerRef:ctx.assigned.snapshotRef,
      items,...locked,
      notice:'No proposed units, original documents or customer data are shown. Reviewer-account objections cannot approve stock, prove human identity or close count disputes.',
    };
  }
  respond(user,physical,website,raw,clock=Date.now()){
    reviewerOnly(user);
    const data=reviewerSchema.parse(raw);
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const history=packetHistory(this.db),responses=reviewerHistory(this.db);
      const replay=responses.find(r=>r.requestId===data.requestId);
      if(replay){
        if(replay.actor!==user.id||replay.packetId!==data.packetId||
          replay.expectedReviewerRef!==data.expectedReviewerRef||
          replay.finding!==data.finding||replay.note!==data.note)
          throw new AppError('Reviewer packet UUID reused with altered contents.',409,
            'RECONCILIATION_REVIEW_REPLAY_CONFLICT');
        this.db.exec('COMMIT');
        return {kind:'reviewer-provisional-reconciliation-objection',
          eventId:replay.id,replayed:true,...locked};
      }
      const ctx=this.reviewerContext(user,physical,website,clock);
      if(data.expectedReviewerRef!==ctx.assigned.snapshotRef)
        throw new AppError('The reviewer evidence changed.',409,
          'RECONCILIATION_REVIEWER_SNAPSHOT_STALE');
      const packet=history.find(p=>p.id===data.packetId);
      if(!packet||!this.visiblePacket(packet,ctx,user,history))
        throw new AppError('No current assigned reconciliation proposal.',403,
          'RECONCILIATION_PACKET_NOT_ASSIGNED');
      if(responses.some(r=>r.packetId===packet.id))
        throw new AppError('This proposal already has a reviewer-account finding.',409,
          'RECONCILIATION_REVIEW_ALREADY_RECORDED');
      const id=addEvent(this.db,user,'inventory.reconciliation_packet_reviewed',{
        ...data,grantId:packet.grantId,reportRow:packet.reportRow,
        reviewerId:user.id,readinessRef:packet.readinessRef,
      });
      this.db.exec('COMMIT');
      return {kind:'reviewer-provisional-reconciliation-objection',
        eventId:id,replayed:false,...locked};
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
}
