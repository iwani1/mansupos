import { createHash } from 'node:crypto';
import { z } from 'zod';
import { audit } from './db.js';
import { AppError } from './errors.js';

// Metadata-only document integrity claims. Never receive/store file contents.
// A hash match proves byte equality ONLY, not a human signature or count.
const sha=/^[0-9a-f]{64}$/;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const code=/^[A-Za-z0-9][A-Za-z0-9_-]{3,47}$/;
const maxBytes=10*1024*1024;
const formats=['application/pdf','image/png','image/jpeg'];
const kinds=['count_sheet','witness_statement','garment_photo'];
const statuses=['all','missing_manifest','manifest_unverified','count_discrepancy_open','identity_hold','waiting_for_counts'];
export const evidenceManifestSchema=z.object({
  reportRow:z.number().int().min(1).max(10000),
  expectedRef:z.string().regex(sha),
  expectedLatestManifestId:z.number().int().positive().nullable(),
  firstClaimId:z.number().int().positive(),
  secondClaimId:z.number().int().positive(),
  documentCode:z.string().trim().regex(code),
  documentType:z.enum(kinds),
  mime:z.enum(formats),
  fileBytes:z.number().int().min(8).max(maxBytes),
  fileSha256:z.string().regex(sha),
  requestId:z.string().regex(uuid),
}).strict();

function load(db){
  const events=[];
  for(const record of db.prepare(
    "SELECT id,actor,subject,created_at FROM audit WHERE action='inventory.private_count_file_manifest' ORDER BY id ASC"
  ).all()){
    let d;
    try{d=JSON.parse(record.subject);}catch{continue;}
    if(d?.schemaVersion!==1||!sha.test(d.supervisionRef||'')||
       !sha.test(d.sourceHash||'')||!sha.test(d.fileSha256||'')||
       !Number.isSafeInteger(d.reportRow)||d.reportRow<1||
       !Number.isSafeInteger(d.firstClaimId)||d.firstClaimId<1||
       !Number.isSafeInteger(d.secondClaimId)||d.secondClaimId<1||
       typeof d.documentCode!=='string'||!code.test(d.documentCode)||
       !kinds.includes(d.documentType)||!formats.includes(d.mime)||
       !Number.isSafeInteger(d.fileBytes)||d.fileBytes<8||d.fileBytes>maxBytes||
       !uuid.test(d.requestId||'')||!sha.test(d.expectedRef||''))continue;
    events.push({...d,id:record.id,actor:record.actor,recordedAt:record.created_at});
  }
  return events;
}

function latestFor(events,supervisionRef,sourceHash){
  const latest=new Map();
  for(const x of events){
    if(x.supervisionRef===supervisionRef&&x.sourceHash===sourceHash)
      latest.set(x.reportRow,x);
  }
  return latest;
}
function base(supervision,physical,website,clock){
  const rows=[];
  const report=supervision.list(physical,website,{page:1,pageSize:1},clock,rows);
  return {report,rows};
}
function registerRef(report,rows,latest,sourceHash){
  return createHash('sha256').update(JSON.stringify({
    sourceHash,supervisionRef:report.snapshotRef,
    items:rows.map(r=>({
      row:r.reportRow,sku:r.sku,
      first:r.firstClaimId,second:r.secondClaimId,
      manifest:latest.get(r.reportRow)?.id??null,
    })),
  })).digest('hex');
}
function publicManifest(x,row){
  if(!x)return null;
  return {
    id:x.id,documentCode:x.documentCode,documentType:x.documentType,
    mime:x.mime,fileBytes:x.fileBytes,fileSha256:x.fileSha256,
    submittedByAccount:x.actor,recordedAt:x.recordedAt,
    requiresRecheck:x.firstClaimId!==row.firstClaimId||
      x.secondClaimId!==row.secondClaimId,
    documentContentUploaded:false,signatureVerified:false,
    independentWitnessVerified:false,
  };
}
export class PrivateCountFileManifests{
  constructor(db,supervision){this.db=db;this.supervision=supervision;}
  list(physical,website,query={},clock=Date.now()){
    const {page=1,pageSize=25,status='all',search=''}=query;
    if(!Number.isSafeInteger(page)||page<1||page>10000||
       !Number.isSafeInteger(pageSize)||pageSize<1||pageSize>50||
       !statuses.includes(status)||typeof search!=='string'||search.length>64)
      throw new AppError('Invalid document manifest review filter.',400,
        'COUNT_DOCUMENT_FILTER_INVALID');
    const {report,rows}=base(this.supervision,physical,website,clock);
    const latest=latestFor(load(this.db),report.snapshotRef,physical?.manifestHash);
    const revision=registerRef(report,rows,latest,physical?.manifestHash);
    const full=rows.map(row=>{
      const manifest=publicManifest(latest.get(row.reportRow),row);
      let state;
      if(row.status==='identity_hold')state='identity_hold';
      else if(row.status==='waiting_for_two_counts')state='waiting_for_counts';
      else if(row.status==='count_discrepancy_open')state='count_discrepancy_open';
      else if(manifest)state='manifest_unverified';
      else state='missing_manifest';
      return {
        reportRow:row.reportRow,sku:row.sku,
        countStage:row.countStage,
        firstClaimId:row.firstClaimId,secondClaimId:row.secondClaimId,
        status:state,latestManifest:manifest,
        mayRecord:report.evidenceVerified&&
          row.firstClaimId!=null&&row.secondClaimId!=null&&
          row.status!=='identity_hold',
        approved:false,stockImportAuthorized:false,
      };
    });
    const totalManifests=full.filter(x=>x.latestManifest).length;
    const sharedDigestCounts=new Map();
    for(const row of full){
      if(row.latestManifest){
        const key=row.latestManifest.fileSha256;
        sharedDigestCounts.set(key,(sharedDigestCounts.get(key)||0)+1);
      }
    }
    for(const row of full){
      if(row.latestManifest)
        row.latestManifest.sameBytesReferencedElsewhere=
          (sharedDigestCounts.get(row.latestManifest.fileSha256)||0)>1;
    }
    const needle=search.trim().toUpperCase();
    const selected=full.filter(x=>
      (status==='all'||x.status===status)&&
      (!needle||x.sku.toUpperCase().includes(needle)||
        String(x.reportRow).includes(needle)));
    const total=selected.length,pages=Math.max(1,Math.ceil(total/pageSize));
    return {
      kind:'owner-private-count-file-manifest-review',auditOnly:true,
      snapshotRef:revision,supervisionRef:report.snapshotRef,
      evidenceVerified:report.evidenceVerified,sourceHash:physical?.manifestHash,
      totalRecordedUnverified:totalManifests,
      documentContentUploaded:false,fileSignatureVerified:false,
      independentWitnessVerified:false,ownerApproved:false,
      mappingApproved:false,sharedStockVerified:false,
      stockImportAuthorized:false,checkoutAuthorized:false,
      page,pageSize,pages,total,hasMore:page<pages,
      items:selected.slice((page-1)*pageSize,page*pageSize),
      notice:'Only the file SHA-256 and metadata were submitted; server cannot verify the file exists, its provenance, signatures, witnessed counts or an inventory quantity.',
    };
  }
  submit(user,physical,website,raw,clock=Date.now()){
    if(user?.role!=='owner')
      throw new AppError('Only the Owner may register count document fingerprints.',403,
        'COUNT_DOCUMENT_OWNER_ONLY');
    const data=evidenceManifestSchema.parse(raw);
    const {report,rows}=base(this.supervision,physical,website,clock);
    if(!report.evidenceVerified||!sha.test(physical?.manifestHash||''))
      throw new AppError('Source or published Woo identity evidence is stale.',409,
        'COUNT_DOCUMENT_EVIDENCE_STALE');
    if(rows.filter(x=>x.reportRow===data.reportRow).length!==1)
      throw new AppError('Historical report row missing or ambiguous.',409,
        'COUNT_DOCUMENT_ROW_AMBIGUOUS');
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const events=load(this.db);
      const replay=events.find(x=>x.requestId===data.requestId);
      if(replay){
        const same=replay.actor===user.id&&
          replay.expectedRef===data.expectedRef&&
          replay.reportRow===data.reportRow&&
          replay.firstClaimId===data.firstClaimId&&
          replay.secondClaimId===data.secondClaimId&&
          replay.documentCode===data.documentCode&&
          replay.documentType===data.documentType&&
          replay.mime===data.mime&&
          replay.fileBytes===data.fileBytes&&
          replay.fileSha256===data.fileSha256&&
          replay.supervisionRef===report.snapshotRef&&
          replay.sourceHash===physical.manifestHash;
        if(!same)throw new AppError('Document request UUID reused with different evidence.',409,
          'COUNT_DOCUMENT_REPLAY_CONFLICT');
        this.db.exec('COMMIT');
        return {kind:'unverified-local-count-file-manifest',recorded:true,
          replayed:true,manifestId:replay.id,auditOnly:true,
          documentContentUploaded:false,independentWitnessVerified:false,
          ownerApproved:false,stockImportAuthorized:false,checkoutAuthorized:false};
      }
      const fresh=base(this.supervision,physical,website,clock);
      const latest=latestFor(events,fresh.report.snapshotRef,physical.manifestHash);
      const reference=registerRef(fresh.report,fresh.rows,latest,physical.manifestHash);
      if(data.expectedRef!==reference)
        throw new AppError('Count evidence or document register changed. Reload the register.',409,
          'COUNT_DOCUMENT_SNAPSHOT_CHANGED');
      const row=fresh.rows.find(x=>x.reportRow===data.reportRow);
      if(!row||row.firstClaimId!==data.firstClaimId||
         row.secondClaimId!==data.secondClaimId||
         !Number.isSafeInteger(row.firstClaimId)||
         !Number.isSafeInteger(row.secondClaimId)||
         row.firstClaimId===row.secondClaimId||
         row.status==='identity_hold'||row.status==='waiting_for_two_counts'||
         !['matching_claims_unverified','discrepant_claims'].includes(row.countStage))
        throw new AppError('Two current independent-account count claims required.',409,
          'COUNT_DOCUMENT_CLAIMS_INVALID');
      const previous=latest.get(data.reportRow);
      if(data.expectedLatestManifestId!==(previous?.id??null))
        throw new AppError('A newer document manifest exists; reload the case.',409,
          'COUNT_DOCUMENT_NEWER_MANIFEST');
      audit(this.db,user.id,'inventory.private_count_file_manifest',JSON.stringify({
        schemaVersion:1,sourceHash:physical.manifestHash,
        supervisionRef:fresh.report.snapshotRef,expectedRef:data.expectedRef,
        reportRow:data.reportRow,firstClaimId:data.firstClaimId,
        secondClaimId:data.secondClaimId,
        documentCode:data.documentCode,documentType:data.documentType,
        mime:data.mime,fileBytes:data.fileBytes,fileSha256:data.fileSha256,
        requestId:data.requestId,
      }));
      const inserted=this.db.prepare(
        "SELECT id FROM audit WHERE action='inventory.private_count_file_manifest' ORDER BY id DESC LIMIT 1"
      ).get();
      this.db.exec('COMMIT');
      return {kind:'unverified-local-count-file-manifest',recorded:true,
        replayed:false,manifestId:inserted.id,auditOnly:true,
        documentContentUploaded:false,independentWitnessVerified:false,
        ownerApproved:false,stockImportAuthorized:false,checkoutAuthorized:false};
    }catch(err){
      this.db.exec('ROLLBACK');
      throw err;
    }
  }
}
