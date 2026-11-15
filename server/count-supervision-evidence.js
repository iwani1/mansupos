import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AppError } from './errors.js';
import { audit } from './db.js';

// Owner observation notes are NOT an independent witness, official stock
// count, authenticated photo/file evidence, product signoff or Woo stock action.
const ref=/^[a-f0-9]{64}$/;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const actions=['observed_count_procedure','request_signed_evidence','flag_discrepancy'];
const documentCode=/^[A-Za-z0-9][A-Za-z0-9_-]{3,47}$/;
export const witnessNoteSchema=z.object({
  reportRow:z.number().int().min(1).max(10000),
  expectedRef:z.string().regex(ref),
  firstClaimId:z.number().int().positive(),
  secondClaimId:z.number().int().positive(),
  expectedLatestNoteId:z.number().int().positive().nullable(),
  action:z.enum(actions),
  documentCode:z.string().trim().regex(documentCode).nullable(),
  note:z.string().trim().min(8).max(180).refine(
    x=>!/[\r\n]/.test(x),'Notes must remain on one line.'),
  requestId:z.string().regex(uuid),
}).strict();

function readNotes(db){
  const out=[];
  for(const event of db.prepare(
    "SELECT id,actor,subject,created_at FROM audit WHERE action='inventory.count_supervision_note' ORDER BY id ASC"
  ).all()){
    let data;
    try{data=JSON.parse(event.subject);}catch{continue;}
    if(data?.schemaVersion!==1||!ref.test(data.planRef||'')||
       !ref.test(data.evidenceRef||'')||
       !ref.test(data.sourceHash||'')||
       !Number.isSafeInteger(data.reportRow)||data.reportRow<1||
       !Number.isSafeInteger(data.firstClaimId)||data.firstClaimId<1||
       !Number.isSafeInteger(data.secondClaimId)||data.secondClaimId<1||
       !actions.includes(data.action)||!uuid.test(data.requestId||'')||
       !(data.documentCode===null||typeof data.documentCode==='string'&&
          documentCode.test(data.documentCode))||
       typeof data.note!=='string'||data.note.length<8||data.note.length>180)
      continue;
    out.push({...data,id:event.id,actor:event.actor,recordedAt:event.created_at});
  }
  return out;
}
function ownerCounts(countClaims,physical,website,clock){
  const rows=[];
  const report=countClaims.ownerReview(physical,website,
    {page:1,pageSize:1},clock,rows);
  return {report,rows};
}
function currentNotes(events,planRef,sourceHash){
  const latest=new Map();
  for(const e of events){
    if(e.planRef===planRef&&e.sourceHash===sourceHash)
      latest.set(e.reportRow,e);
  }
  return latest;
}
// Includes the latest claim and observation event IDs, so paging fails
// closed if a staff count or supervisor note changes mid-review.
function evidenceRef(report,rows,notes,sourceHash){
  const latest=currentNotes(notes,report.snapshotRef,sourceHash);
  return createHash('sha256').update(JSON.stringify({
    sourceHash,identityRef:report.snapshotRef,
    rows:rows.map(row=>({
      reportRow:row.reportRow,sku:row.sku,stage:row.stage,
      firstClaimId:row.firstClaimId,secondClaimId:row.secondClaimId,
      latestNoteId:latest.get(row.reportRow)?.id??null,
    })),
  })).digest('hex');
}
function viewRow(row,event){
  const both=Number.isSafeInteger(row.firstClaimId)&&
    Number.isSafeInteger(row.secondClaimId);
  const note=event?{
    id:event.id,action:event.action,note:event.note,
    documentCode:event.documentCode,actor:event.actor,
    recordedAt:event.recordedAt,
    requiresRecheck:event.firstClaimId!==row.firstClaimId||
      event.secondClaimId!==row.secondClaimId,
  }:null;
  let status;
  if(row.stage==='identity_hold')status='identity_hold';
  else if(!both)status='waiting_for_two_counts';
  else if(row.stage==='discrepant_claims')status='count_discrepancy_open';
  else if(note?.requiresRecheck)status='supervision_note_stale';
  else if(note)status='supervision_note_unverified';
  else status='supervision_note_needed';
  return {
    reportRow:row.reportRow,sku:row.sku,
    countStage:row.stage,
    firstClaimId:row.firstClaimId,secondClaimId:row.secondClaimId,
    firstCounterAccountId:row.firstActor,
    secondCounterAccountId:row.secondActor,
    firstRecordedAt:row.firstSubmittedAt,
    secondRecordedAt:row.secondSubmittedAt,
    status,latestNote:note,
    physicallyWitnessed:false,acceptedInventory:false,
  };
}
export class CountSupervisionEvidence {
  constructor(db,countClaims){this.db=db;this.countClaims=countClaims;}

  list(physical,website,options={},clock=Date.now(),collectRows=null){
    const {page=1,pageSize=25,search='',status='all'}=options;
    const allowed=new Set([
      'all','identity_hold','waiting_for_two_counts',
      'count_discrepancy_open','supervision_note_stale',
      'supervision_note_unverified','supervision_note_needed',
    ]);
    if(!Number.isSafeInteger(page)||page<1||page>10000||
       !Number.isSafeInteger(pageSize)||pageSize<1||pageSize>50||
       typeof search!=='string'||search.length>64||!allowed.has(status))
      throw new AppError('Invalid supervised count evidence filter.',400,
        'COUNT_SUPERVISION_INVALID_FILTER');
    const {report,rows}=ownerCounts(this.countClaims,physical,website,clock);
    const notes=readNotes(this.db);
    const latest=currentNotes(notes,report.snapshotRef,physical?.manifestHash);
    const revision=evidenceRef(report,rows,notes,physical?.manifestHash);
    const all=rows.map(row=>viewRow(row,latest.get(row.reportRow)));
    if(Array.isArray(collectRows))collectRows.push(...all);
    const totals={
      awaitingTwoCounts:all.filter(x=>x.status==='waiting_for_two_counts').length,
      openDiscrepancies:all.filter(x=>x.status==='count_discrepancy_open').length,
      unverifiedNotes:all.filter(x=>x.latestNote&&!x.latestNote.requiresRecheck).length,
      physicalWitnessesVerified:0,
    };
    const needle=search.trim().toUpperCase();
    const selected=all.filter(r=>(status==='all'||status===r.status)&&(
      !needle||r.sku.toUpperCase().includes(needle)||String(r.reportRow).includes(needle)));
    const total=selected.length,pages=Math.max(1,Math.ceil(total/pageSize));
    return {
      kind:'local-count-supervision-evidence',auditOnly:true,
      evidenceVerified:report.evidenceVerified,
      snapshotRef:revision,identityRef:report.snapshotRef,
      sourceHash:physical?.manifestHash,
      physicallyWitnessed:false,independentWitnessVerified:false,
      ownerApproved:false,mappingApproved:false,sharedStockVerified:false,
      stockImportAuthorized:false,checkoutAuthorized:false,
      page,pageSize,pages,total,hasMore:page<pages,totals,
      items:selected.slice((page-1)*pageSize,page*pageSize),
      notice:'Account-bound supervisor notes and private document reference codes are claims only. No photographs, signed files or physical witnessing are authenticated by this feature.',
    };
  }

  submit(user,physical,website,raw,clock=Date.now()){
    if(user?.role!=='owner')
      throw new AppError('Only the owner can record supervised count observations.',403,
        'COUNT_SUPERVISION_OWNER_ONLY');
    const data=witnessNoteSchema.parse(raw);
    const {report,rows}=ownerCounts(this.countClaims,physical,website,clock);
    if(!report.evidenceVerified||!ref.test(physical?.manifestHash||''))
      throw new AppError('Physical source or Woo identity evidence is stale.',409,
        'COUNT_SUPERVISION_SOURCE_STALE');
    if(rows.filter(x=>x.reportRow===data.reportRow).length!==1)
      throw new AppError('Historical source row missing or duplicated.',409,
        'COUNT_SUPERVISION_ROW_AMBIGUOUS');
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const entries=readNotes(this.db);
      const replay=entries.find(x=>x.requestId===data.requestId);
      if(replay){
        const same=replay.actor===user.id&&replay.planRef===report.snapshotRef&&
          replay.sourceHash===physical.manifestHash&&
          replay.reportRow===data.reportRow&&
          replay.firstClaimId===data.firstClaimId&&
          replay.secondClaimId===data.secondClaimId&&
          replay.action===data.action&&
          replay.documentCode===data.documentCode&&replay.note===data.note&&
          replay.evidenceRef===data.expectedRef;
        if(!same)
          throw new AppError('Request identifier belongs to a different evidence note.',409,
            'COUNT_SUPERVISION_REPLAY_CONFLICT');
        this.db.exec('COMMIT');
        return {
          kind:'unverified-count-supervision-note',recorded:true,
          replayed:true,noteId:replay.id,auditOnly:true,
          independentWitnessVerified:false,ownerApproved:false,
          stockImportAuthorized:false,checkoutAuthorized:false,
        };
      }
      // Compare complete source+claim+observation revision after replay check.
      // This allows a lost-response retry but rejects new stale submissions.
      const fresh=ownerCounts(this.countClaims,physical,website,clock);
      const currentRef=evidenceRef(fresh.report,fresh.rows,entries,
        physical.manifestHash);
      if(data.expectedRef!==currentRef)
        throw new AppError('Count or supervision evidence changed. Reload review.',409,
          'COUNT_SUPERVISION_SNAPSHOT_CHANGED');
      const current=fresh.rows.find(x=>x.reportRow===data.reportRow);
      if(!current||current.firstClaimId!==data.firstClaimId||
         current.secondClaimId!==data.secondClaimId||
         !current.firstActor||!current.secondActor||
         current.firstActor===current.secondActor||
         current.firstActor===user.id||current.secondActor===user.id||
         !['matching_claims_unverified','discrepant_claims'].includes(current.stage))
        throw new AppError('Two distinct staff count claims are required, bound to the observed case.',409,
          'COUNT_SUPERVISION_CLAIMS_INVALID');
      if(data.action==='flag_discrepancy'&&current.stage!=='discrepant_claims')
        throw new AppError('A discrepancy flag requires unequal count claims.',409,
          'COUNT_SUPERVISION_NO_DISCREPANCY');
      if(data.action==='observed_count_procedure'&&current.stage==='discrepant_claims')
        throw new AppError('Conflicting count claims cannot be recorded as matching supervision.',409,
          'COUNT_SUPERVISION_DISCREPANCY_OPEN');
      const latest=currentNotes(entries,report.snapshotRef,physical.manifestHash)
        .get(data.reportRow);
      if(data.expectedLatestNoteId!==(latest?.id??null))
        throw new AppError('A newer observation exists. Reload this case.',409,
          'COUNT_SUPERVISION_NOTE_CHANGED');
      audit(this.db,user.id,'inventory.count_supervision_note',JSON.stringify({
        schemaVersion:1,planRef:report.snapshotRef,
        evidenceRef:data.expectedRef,
        sourceHash:physical.manifestHash,reportRow:data.reportRow,
        firstClaimId:data.firstClaimId,secondClaimId:data.secondClaimId,
        action:data.action,documentCode:data.documentCode,
        note:data.note,requestId:data.requestId,
      }));
      const last=this.db.prepare(
        "SELECT id FROM audit WHERE action='inventory.count_supervision_note' ORDER BY id DESC LIMIT 1"
      ).get();
      this.db.exec('COMMIT');
      return {
        kind:'unverified-count-supervision-note',recorded:true,
        replayed:false,noteId:last.id,auditOnly:true,
        independentWitnessVerified:false,ownerApproved:false,
        stockImportAuthorized:false,checkoutAuthorized:false,
      };
    }catch(error){
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
