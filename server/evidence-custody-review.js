import { createHash } from 'node:crypto';
import { z } from 'zod';
import { audit } from './db.js';
import { AppError } from './errors.js';

// Metadata-only OWNER CUSTODY ASSERTIONS and review handoff PREPARATION.
// No physical file, witness identity, recipient acknowledgement or approval.
const sha=/^[a-f0-9]{64}$/;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const code=/^[A-Za-z0-9][A-Za-z0-9_-]{3,47}$/;
const actions=['sealed_in_private_custody','custody_access_logged','independent_review_requested'];
const channels=['none','in_person','secured_external_channel','sealed_paper_copy'];
const filters=['all','file_manifest_missing','custody_entry_needed',
  'custody_declared_unverified','review_requested_unconfirmed',
  'count_discrepancy_open','identity_hold','waiting_for_counts'];

export const custodyEventSchema=z.object({
  reportRow:z.number().int().min(1).max(10000),
  expectedRef:z.string().regex(sha),
  expectedLatestEventId:z.number().int().positive().nullable(),
  manifestId:z.number().int().positive(),
  fileSha256:z.string().regex(sha),
  firstClaimId:z.number().int().positive(),
  secondClaimId:z.number().int().positive(),
  action:z.enum(actions),
  locationCode:z.string().trim().regex(code),
  reviewChannel:z.enum(channels),
  note:z.string().trim().min(8).max(180).refine(
    value=>!/[\r\n]/.test(value),'Custody notes must fit on one line.'),
  requestId:z.string().regex(uuid),
}).strict().superRefine((data,ctx)=>{
  if(data.action==='independent_review_requested'&&data.reviewChannel==='none')
    ctx.addIssue({code:'custom',path:['reviewChannel'],
      message:'Review preparation requires a proposed secure handoff method.'});
  if(data.action!=='independent_review_requested'&&data.reviewChannel!=='none')
    ctx.addIssue({code:'custom',path:['reviewChannel'],
      message:'A custody note must not imply a separate witness handoff.'});
});

function readEvents(db){
  const result=[];
  const events=db.prepare(
    "SELECT id,actor,subject,created_at FROM audit WHERE action='inventory.private_evidence_custody' ORDER BY id ASC"
  ).all();
  for(const record of events){
    let d;
    try{d=JSON.parse(record.subject);}catch{continue;}
    if(d?.schemaVersion!==1||!sha.test(d.manifestRef||'')||
       !sha.test(d.sourceHash||'')||!sha.test(d.fileSha256||'')||
       !sha.test(d.expectedRef||'')||
       !Number.isSafeInteger(d.reportRow)||d.reportRow<1||
       !Number.isSafeInteger(d.manifestId)||d.manifestId<1||
       !Number.isSafeInteger(d.firstClaimId)||d.firstClaimId<1||
       !Number.isSafeInteger(d.secondClaimId)||d.secondClaimId<1||
       !actions.includes(d.action)||!channels.includes(d.reviewChannel)||
       !code.test(d.locationCode||'')||!uuid.test(d.requestId||'')||
       typeof d.note!=='string'||d.note.length<8||d.note.length>180)
      continue;
    result.push({...d,id:record.id,recordedBy:record.actor,
      recordedAt:record.created_at});
  }
  return result;
}
function newest(events,sourceRef,sourceHash){
  const latest=new Map();
  for(const event of events){
    if(event.manifestRef===sourceRef&&event.sourceHash===sourceHash)
      latest.set(event.reportRow,event);
  }
  return latest;
}
function source(fileManifests,physical,website,clock){
  const rows=[];
  const report=fileManifests.list(physical,website,
    {page:1,pageSize:1},clock,rows);
  return {report,rows};
}
function snapshotRef(report,rows,latest,sourceHash){
  return createHash('sha256').update(JSON.stringify({
    sourceHash,manifestRef:report.snapshotRef,
    rows:rows.map(row=>({
      reportRow:row.reportRow,sku:row.sku,
      manifestId:row.latestManifest?.id??null,
      first:row.firstClaimId,second:row.secondClaimId,
      custodyEventId:latest.get(row.reportRow)?.id??null,
    })),
  })).digest('hex');
}
function selectRow(row,event){
  const manifest=row.latestManifest;
  const safeEvent=event?{
    id:event.id,action:event.action,locationCode:event.locationCode,
    reviewChannel:event.reviewChannel,note:event.note,
    recordedByAccount:event.recordedBy,recordedAt:event.recordedAt,
    needsRecheck:event.manifestId!==manifest?.id||
      event.firstClaimId!==row.firstClaimId||
      event.secondClaimId!==row.secondClaimId||
      event.fileSha256!==manifest?.fileSha256,
    independentReviewConfirmed:false,
  }:null;
  const stale=manifest?.requiresRecheck===true||safeEvent?.needsRecheck===true;
  let state;
  if(row.status==='identity_hold')state='identity_hold';
  else if(row.status==='waiting_for_counts')state='waiting_for_counts';
  else if(!manifest)state='file_manifest_missing';
  else if(row.status==='count_discrepancy_open')state='count_discrepancy_open';
  else if(stale)state='custody_entry_needed';
  else if(!safeEvent)state='custody_entry_needed';
  else if(safeEvent.action==='independent_review_requested')
    state='review_requested_unconfirmed';
  else state='custody_declared_unverified';
  return {
    reportRow:row.reportRow,sku:row.sku,
    firstClaimId:row.firstClaimId,secondClaimId:row.secondClaimId,
    manifest:manifest?{
      id:manifest.id,documentCode:manifest.documentCode,
      documentType:manifest.documentType,fileSha256:manifest.fileSha256,
      fileBytes:manifest.fileBytes,requiresRecheck:manifest.requiresRecheck,
      signatureVerified:false,
    }:null,
    status:state,countDiscrepancyOpen:row.status==='count_discrepancy_open',
    latestCustodyEvent:safeEvent,
    mayRecord:row.mayRecord&&Boolean(manifest)&&
      !manifest.requiresRecheck&&row.status!=='identity_hold'&&
      row.status!=='waiting_for_counts',
    independentReviewConfirmed:false,originalAuthenticityVerified:false,
    inventoryAccepted:false,stockImportAuthorized:false,
  };
}
export class EvidenceCustodyReview{
  constructor(db,fileManifests){this.db=db;this.fileManifests=fileManifests;}
  list(physical,website,query={},clock=Date.now(),collectRows=null){
    const {page=1,pageSize=25,search='',status='all'}=query;
    if(!Number.isSafeInteger(page)||page<1||page>10000||
       !Number.isSafeInteger(pageSize)||pageSize<1||pageSize>50||
       typeof search!=='string'||search.length>64||
       !filters.includes(status))
      throw new AppError('Invalid evidence custody filters.',400,
        'EVIDENCE_CUSTODY_INVALID_FILTER');
    const {report,rows}=source(this.fileManifests,physical,website,clock);
    const latest=newest(readEvents(this.db),report.snapshotRef,physical?.manifestHash);
    const ref=snapshotRef(report,rows,latest,physical?.manifestHash);
    const all=rows.map(row=>selectRow(row,latest.get(row.reportRow)));
    if(Array.isArray(collectRows))collectRows.push(...all);
    const tally={
      manifestMissing:all.filter(row=>!row.manifest).length,
      custodyNotesCurrent:all.filter(row=>row.latestCustodyEvent&&!row.latestCustodyEvent.needsRecheck).length,
      reviewsRequestedUnconfirmed:all.filter(row=>row.latestCustodyEvent?.action==='independent_review_requested'&&!row.latestCustodyEvent.needsRecheck).length,
      countDiscrepanciesOpen:all.filter(row=>row.countDiscrepancyOpen).length,
      independentlyVerifiedOriginals:0,
    };
    const term=search.trim().toUpperCase();
    const selected=all.filter(row=>(status==='all'||row.status===status)&&(
      !term||row.sku.toUpperCase().includes(term)||
      String(row.reportRow).includes(term)||
      String(row.manifest?.documentCode||'').toUpperCase().includes(term)));
    const total=selected.length,pages=Math.max(1,Math.ceil(total/pageSize));
    return {
      kind:'owner-unverified-evidence-custody',auditOnly:true,
      evidenceVerified:report.evidenceVerified,
      snapshotRef:ref,manifestRef:report.snapshotRef,
      sourceHash:physical?.manifestHash,tally,
      documentBytesStored:false,documentSignatureVerified:false,
      independentWitnessVerified:false,independentReviewConfirmed:false,
      ownerApproved:false,mappingApproved:false,sharedStockVerified:false,
      stockImportAuthorized:false,checkoutAuthorized:false,
      page,pageSize,pages,total,hasMore:page<pages,
      items:selected.slice((page-1)*pageSize,page*pageSize),
      notice:'Custody steps and independent-review requests are owner declarations only. No recipient acknowledgement, original file, witness signature or physical stock has been verified.',
    };
  }
  submit(user,physical,website,raw,clock=Date.now()){
    if(user?.role!=='owner')
      throw new AppError('Only the owner may record custody preparation.',403,
        'EVIDENCE_CUSTODY_OWNER_ONLY');
    const data=custodyEventSchema.parse(raw);
    const {report,rows}=source(this.fileManifests,physical,website,clock);
    if(!report.evidenceVerified||!sha.test(physical?.manifestHash||''))
      throw new AppError('Physical or published Woo evidence is stale.',409,
        'EVIDENCE_CUSTODY_SOURCE_STALE');
    if(rows.filter(row=>row.reportRow===data.reportRow).length!==1)
      throw new AppError('Historical row is missing or duplicated.',409,
        'EVIDENCE_CUSTODY_ROW_AMBIGUOUS');
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const existing=readEvents(this.db);
      const replay=existing.find(entry=>entry.requestId===data.requestId);
      if(replay){
        const same=replay.recordedBy===user.id&&
          replay.manifestRef===report.snapshotRef&&
          replay.sourceHash===physical.manifestHash&&
          replay.expectedRef===data.expectedRef&&
          replay.reportRow===data.reportRow&&
          replay.manifestId===data.manifestId&&
          replay.fileSha256===data.fileSha256&&
          replay.firstClaimId===data.firstClaimId&&
          replay.secondClaimId===data.secondClaimId&&
          replay.action===data.action&&
          replay.locationCode===data.locationCode&&
          replay.reviewChannel===data.reviewChannel&&
          replay.note===data.note;
        if(!same)throw new AppError('This custody request ID is already in use.',409,
          'EVIDENCE_CUSTODY_REPLAY_CONFLICT');
        this.db.exec('COMMIT');
        return {
          kind:'unverified-owner-custody-event',recorded:true,
          replayed:true,eventId:replay.id,auditOnly:true,
          documentBytesStored:false,independentReviewConfirmed:false,
          independentWitnessVerified:false,ownerApproved:false,
          stockImportAuthorized:false,checkoutAuthorized:false,
        };
      }
      const current=source(this.fileManifests,physical,website,clock);
      const latest=newest(existing,current.report.snapshotRef,physical.manifestHash);
      const ref=snapshotRef(current.report,current.rows,latest,physical.manifestHash);
      if(ref!==data.expectedRef)
        throw new AppError('Custody or manifest records changed; reload the case.',409,
          'EVIDENCE_CUSTODY_SNAPSHOT_CHANGED');
      const row=current.rows.find(item=>item.reportRow===data.reportRow);
      if(!row||!row.mayRecord||!row.latestManifest||
         row.latestManifest.requiresRecheck||
         row.status==='identity_hold'||row.status==='waiting_for_counts'||
         row.latestManifest.id!==data.manifestId||
         row.latestManifest.fileSha256!==data.fileSha256||
         row.firstClaimId!==data.firstClaimId||
         row.secondClaimId!==data.secondClaimId)
        throw new AppError('Original claim or document fingerprint was changed or missing.',409,
          'EVIDENCE_CUSTODY_MANIFEST_CHANGED');
      const prior=latest.get(data.reportRow);
      if(data.expectedLatestEventId!==(prior?.id??null))
        throw new AppError('A newer custody note exists; reload review.',409,
          'EVIDENCE_CUSTODY_EVENT_CHANGED');
      if(data.action!=='sealed_in_private_custody'&&!existing.some(entry=>
        entry.manifestRef===current.report.snapshotRef&&
        entry.sourceHash===physical.manifestHash&&
        entry.reportRow===data.reportRow&&
        entry.manifestId===data.manifestId&&
        entry.action==='sealed_in_private_custody')){
        throw new AppError('First record a private-custody seal declaration for this exact file manifest.',409,
          'EVIDENCE_CUSTODY_SEAL_REQUIRED');
      }
      audit(this.db,user.id,'inventory.private_evidence_custody',JSON.stringify({
        schemaVersion:1,sourceHash:physical.manifestHash,
        manifestRef:current.report.snapshotRef,expectedRef:data.expectedRef,
        reportRow:data.reportRow,manifestId:data.manifestId,
        fileSha256:data.fileSha256,firstClaimId:data.firstClaimId,
        secondClaimId:data.secondClaimId,action:data.action,
        locationCode:data.locationCode,reviewChannel:data.reviewChannel,
        note:data.note,requestId:data.requestId,
      }));
      const saved=this.db.prepare(
        "SELECT id FROM audit WHERE action='inventory.private_evidence_custody' ORDER BY id DESC LIMIT 1"
      ).get();
      this.db.exec('COMMIT');
      return {
        kind:'unverified-owner-custody-event',recorded:true,
        replayed:false,eventId:saved.id,auditOnly:true,
        documentBytesStored:false,independentReviewConfirmed:false,
        independentWitnessVerified:false,ownerApproved:false,
        stockImportAuthorized:false,checkoutAuthorized:false,
      };
    }catch(err){
      this.db.exec('ROLLBACK');
      throw err;
    }
  }
}
