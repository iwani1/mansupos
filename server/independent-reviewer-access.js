import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { audit, hashPassword } from './db.js';
import { AppError } from './errors.js';

// A separate reviewer ACCOUNT may acknowledge only metadata explicitly assigned
// to it. POS-account authentication is not real-world identity verification,
// proof of document delivery, independent physical witnessing or stock approval.
const sha = /^[a-f0-9]{64}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const username = /^review\.[a-z0-9][a-z0-9._-]{2,35}$/;
const outcomes = ['review_request_seen','evidence_issue_reported','unable_to_review'];
const issues = ['document_hash_mismatch','signature_missing','count_numbers_conflict',
  'garment_variation_conflict','reviewer_identity_unconfirmed','other_evidence_issue'];

const newAccountSchema = z.object({
  username:z.string().trim().toLowerCase().regex(username),
}).strict();
const grantSchema = z.object({
  reviewerId:z.string().uuid(),
  reportRow:z.number().int().min(1).max(10000),
  expectedRef:z.string().regex(sha),
  custodyRequestId:z.number().int().positive(),
  manifestId:z.number().int().positive(),
  fileSha256:z.string().regex(sha),
  firstClaimId:z.number().int().positive(),
  secondClaimId:z.number().int().positive(),
  requestId:z.string().regex(uuid),
}).strict();
const revokeSchema = z.object({
  grantId:z.number().int().positive(),
  requestId:z.string().regex(uuid),
}).strict();
const acknowledgementSchema = z.object({
  grantId:z.number().int().positive(),
  expectedRef:z.string().regex(sha),
  outcome:z.enum(outcomes),
  issueCode:z.enum(issues).nullable(),
  note:z.string().trim().min(12).max(180).refine(x=>!/[\r\n]/.test(x)),
  requestId:z.string().regex(uuid),
}).strict().superRefine((value,ctx)=>{
  if((value.outcome==='evidence_issue_reported')!==Boolean(value.issueCode))
    ctx.addIssue({code:'custom',path:['issueCode'],
      message:'Only a reported issue can carry an issue code.'});
});
const locked = Object.freeze({
  auditOnly:true,reviewerAccountAuthenticated:true,
  reviewerHumanIdentityVerified:false,reviewerIndependenceVerified:false,
  independentReviewConfirmed:false,originalFileDeliveredByPOS:false,
  originalDocumentVerified:false,signatureVerified:false,
  physicalCountVerified:false,independentWitnessVerified:false,
  ownerApproved:false,mappingApproved:false,sharedStockVerified:false,
  stockImportAuthorized:false,checkoutAuthorized:false,
});
function ownerOnly(user){
  if(user?.role!=='owner')throw new AppError('Only the Owner can manage independent reviewer access.',403,'REVIEWER_ACCESS_OWNER_ONLY');
}
function reviewerOnly(user){
  if(user?.role!=='reviewer')throw new AppError('Only a dedicated reviewer account may acknowledge a case.',403,'REVIEWER_ACCOUNT_REQUIRED');
}
function events(db,action){
  const entries=db.prepare('SELECT id,actor,subject,created_at FROM audit WHERE action=? ORDER BY id ASC').all(action);
  return entries.flatMap(entry=>{
    try{
      const value=JSON.parse(entry.subject);
      if(value?.schemaVersion!==1||!uuid.test(value.requestId||''))return [];
      return [{...value,id:entry.id,actor:entry.actor,recordedAt:entry.created_at}];
    }catch{return [];}
  });
}
function grants(db){
  return events(db,'inventory.reviewer_access_granted').filter(x=>
    uuid.test(x.reviewerId||'')&&sha.test(x.sourceHash||'')&&
    sha.test(x.custodyRef||'')&&sha.test(x.expectedRef||'')&&
    sha.test(x.fileSha256||'')&&Number.isSafeInteger(x.reportRow)&&
    Number.isSafeInteger(x.custodyRequestId)&&Number.isSafeInteger(x.manifestId)&&
    Number.isSafeInteger(x.firstClaimId)&&Number.isSafeInteger(x.secondClaimId));
}
function revocations(db){
  return events(db,'inventory.reviewer_access_revoked').filter(x=>
    Number.isSafeInteger(x.grantId)&&x.grantId>0);
}
function acknowledgements(db){
  return events(db,'inventory.reviewer_account_acknowledgement').filter(x=>
    Number.isSafeInteger(x.grantId)&&x.grantId>0&&
    uuid.test(x.reviewerId||'')&&sha.test(x.expectedRef||'')&&
    outcomes.includes(x.outcome)&&
    (x.issueCode===null||issues.includes(x.issueCode)));
}
function isSameCase(row,grant){
  return Boolean(row?.mayReport&&row.custodyRequestId===grant.custodyRequestId&&
    row.manifestId===grant.manifestId&&row.fileSha256===grant.fileSha256&&
    row.firstClaimId===grant.firstClaimId&&row.secondClaimId===grant.secondClaimId);
}
function context(intake,physical,website,clock){
  const rows=[];
  const report=intake.list(physical,website,{page:1,pageSize:1},clock,rows);
  if(!report.evidenceVerified||!sha.test(physical?.manifestHash||'')){
    throw new AppError('Source or Woo identity must be refreshed before reviewer access.',409,
      'REVIEWER_ACCESS_SOURCE_STALE');
  }
  return {report,rows,sourceHash:physical.manifestHash};
}
function matchGrant(ctx,grant){
  return ctx.sourceHash===grant.sourceHash&&
    ctx.report.custodyRef===grant.custodyRef&&
    isSameCase(ctx.rows.find(x=>x.reportRow===grant.reportRow),grant);
}
function snapshot(ctx,grant,revoked,ack){
  const row=ctx.rows.find(x=>x.reportRow===grant.reportRow);
  const current=!revoked&&matchGrant(ctx,grant);
  return {
    grantId:grant.id,reportRow:grant.reportRow,
    sku:current?row.sku:null,
    custodyRequestId:grant.custodyRequestId,manifestId:grant.manifestId,
    fileSha256:grant.fileSha256,firstClaimId:grant.firstClaimId,
    secondClaimId:grant.secondClaimId,
    status:revoked?'revoked':current?'assigned_metadata_only':'stale_evidence',
    mayAcknowledge:current,
    countDiscrepancyOpen:current?row.countDiscrepancyOpen:null,
    latestAcknowledgement:ack?{
      id:ack.id,outcome:ack.outcome,issueCode:ack.issueCode,
      note:ack.note,recordedAt:ack.recordedAt,
      authenticatedPOSAccount:true,humanIdentityVerified:false,
      physicalCountVerified:false,
    }:null,
    ...locked,
  };
}
function latestAcknowledgement(list,grantId){
  return list.filter(x=>x.grantId===grantId).at(-1)||null;
}
function insertAudit(db,userId,action,payload){
  audit(db,userId,action,JSON.stringify({schemaVersion:1,...payload}));
  return db.prepare('SELECT id FROM audit WHERE action=? ORDER BY id DESC LIMIT 1').get(action).id;
}

export class IndependentReviewerAccess{
  constructor(db,intake){this.db=db;this.intake=intake;}

  provision(user,raw){
    ownerOnly(user);
    const data=newAccountSchema.parse(raw);
    const password=randomBytes(24).toString('base64url');
    const id=randomUUID();
    this.db.exec('BEGIN IMMEDIATE');
    try{
      if(this.db.prepare('SELECT id FROM users WHERE username=?').get(data.username))
        throw new AppError('Username already exists.',409,'REVIEWER_USERNAME_TAKEN');
      this.db.prepare('INSERT INTO users(id,username,name,role,password_hash,active,created_at,must_change_password) VALUES (?,?,?,?,?,1,?,1)')
        .run(id,data.username,'External reviewer account (identity unverified)',
          'reviewer',hashPassword(password),new Date().toISOString());
      audit(this.db,user.id,'inventory.reviewer_account_created',id);
      this.db.exec('COMMIT');
      return {
        kind:'reviewer-account-created',reviewerId:id,username:data.username,
        temporaryPassword:password,mustChangePassword:true,
        accountProvisioned:true,humanIdentityVerified:false,
        notice:'Deliver the temporary password privately. It is returned only once; a POS login does not prove the holder\'s real-world identity.',
      };
    }catch(err){this.db.exec('ROLLBACK');throw err;}
  }

  grant(user,physical,website,raw,clock=Date.now()){
    ownerOnly(user);
    const data=grantSchema.parse(raw);
    const ctx=context(this.intake,physical,website,clock);
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const history=grants(this.db);
      const replay=history.find(x=>x.requestId===data.requestId);
      if(replay){
        if(replay.actor!==user.id||replay.reviewerId!==data.reviewerId||
           replay.reportRow!==data.reportRow||replay.expectedRef!==data.expectedRef||
           replay.custodyRequestId!==data.custodyRequestId||
           replay.manifestId!==data.manifestId||replay.fileSha256!==data.fileSha256||
           replay.firstClaimId!==data.firstClaimId||
           replay.secondClaimId!==data.secondClaimId)
          throw new AppError('Grant UUID reused for different evidence.',409,'REVIEWER_GRANT_REPLAY_CONFLICT');
        this.db.exec('COMMIT');
        return {kind:'reviewer-case-grant',grantId:replay.id,replayed:true,...locked};
      }
      if(data.expectedRef!==ctx.report.snapshotRef)
        throw new AppError('Reviewer evidence changed; reload before assigning.',409,'REVIEWER_GRANT_SNAPSHOT_STALE');
      const reviewer=this.db.prepare("SELECT id FROM users WHERE id=? AND role='reviewer' AND active=1").get(data.reviewerId);
      if(!reviewer)throw new AppError('Dedicated active reviewer account required.',409,'REVIEWER_ACCOUNT_INACTIVE');
      const row=ctx.rows.find(x=>x.reportRow===data.reportRow);
      if(!row||!isSameCase(row,data))
        throw new AppError('No matching current custody request and file evidence.',409,'REVIEWER_GRANT_CASE_STALE');
      if(history.some(x=>x.reviewerId===data.reviewerId&&
         x.reportRow===data.reportRow&&matchGrant(ctx,x)&&
         !revocations(this.db).some(r=>r.grantId===x.id)))
        throw new AppError('Reviewer already has a current assignment for this case.',409,'REVIEWER_GRANT_DUPLICATE');
      const id=insertAudit(this.db,user.id,'inventory.reviewer_access_granted',{
        ...data,sourceHash:ctx.sourceHash,custodyRef:ctx.report.custodyRef,
      });
      this.db.exec('COMMIT');
      return {kind:'reviewer-case-grant',grantId:id,replayed:false,...locked};
    }catch(err){this.db.exec('ROLLBACK');throw err;}
  }

  revoke(user,raw){
    ownerOnly(user);
    const data=revokeSchema.parse(raw);
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const existing=revocations(this.db);
      const replay=existing.find(x=>x.requestId===data.requestId);
      if(replay){
        if(replay.grantId!==data.grantId||replay.actor!==user.id)
          throw new AppError('Revocation UUID reused.',409,'REVIEWER_REVOKE_REPLAY_CONFLICT');
        this.db.exec('COMMIT');
        return {kind:'reviewer-grant-revoked',revoked:true,replayed:true,grantId:data.grantId};
      }
      if(!grants(this.db).some(x=>x.id===data.grantId))
        throw new AppError('Reviewer grant does not exist.',404,'REVIEWER_GRANT_MISSING');
      if(existing.some(x=>x.grantId===data.grantId))
        throw new AppError('Reviewer grant was already revoked.',409,'REVIEWER_GRANT_REVOKED');
      insertAudit(this.db,user.id,'inventory.reviewer_access_revoked',data);
      this.db.exec('COMMIT');
      return {kind:'reviewer-grant-revoked',revoked:true,replayed:false,grantId:data.grantId};
    }catch(err){this.db.exec('ROLLBACK');throw err;}
  }

  listOwner(user,physical,website,clock=Date.now()){
    ownerOnly(user);
    const ctx=context(this.intake,physical,website,clock);
    const revoked=new Set(revocations(this.db).map(x=>x.grantId));
    const ack=acknowledgements(this.db);
    const accounts=this.db.prepare("SELECT id,username,active FROM users WHERE role='reviewer' ORDER BY username LIMIT 100").all();
    return {
      kind:'owner-reviewer-access-register',
      snapshotRef:ctx.report.snapshotRef,
      cases:ctx.rows.filter(x=>x.mayReport).map(x=>({
        reportRow:x.reportRow,sku:x.sku,custodyRequestId:x.custodyRequestId,
        manifestId:x.manifestId,fileSha256:x.fileSha256,
        firstClaimId:x.firstClaimId,secondClaimId:x.secondClaimId,
        countDiscrepancyOpen:x.countDiscrepancyOpen,
      })),
      accounts:accounts.map(x=>({id:x.id,username:x.username,active:Boolean(x.active)})),
      assignments:grants(this.db).map(g=>({
        reviewerId:g.reviewerId,
        ...snapshot(ctx,g,revoked.has(g.id),latestAcknowledgement(ack,g.id)),
      })),
      ...locked,
      notice:'Account-authenticated review of assigned metadata only. No document bytes, count quantities, customer data, prices or trading rights.',
    };
  }

  listAssigned(user,physical,website,clock=Date.now()){
    reviewerOnly(user);
    const ctx=context(this.intake,physical,website,clock);
    const revoked=new Set(revocations(this.db).map(x=>x.grantId));
    const ack=acknowledgements(this.db);
    return {
      kind:'reviewer-assigned-request-metadata',
      snapshotRef:ctx.report.snapshotRef,
      cases:grants(this.db).filter(g=>g.reviewerId===user.id).map(g=>
        snapshot(ctx,g,revoked.has(g.id),latestAcknowledgement(ack,g.id))),
      ...locked,
      notice:'Your login only authenticates this POS account. No original file is delivered by MansuPOS. Acknowledging this request does not certify documents or physical counts.',
    };
  }

  acknowledge(user,physical,website,raw,clock=Date.now()){
    reviewerOnly(user);
    const data=acknowledgementSchema.parse(raw);
    const ctx=context(this.intake,physical,website,clock);
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const all=acknowledgements(this.db);
      const replay=all.find(x=>x.requestId===data.requestId);
      if(replay){
        if(replay.actor!==user.id||replay.reviewerId!==user.id||
           replay.grantId!==data.grantId||replay.expectedRef!==data.expectedRef||
           replay.outcome!==data.outcome||replay.issueCode!==data.issueCode||
           replay.note!==data.note)
          throw new AppError('Acknowledgement UUID reused with changed contents.',409,'REVIEWER_ACK_REPLAY_CONFLICT');
        this.db.exec('COMMIT');
        return {kind:'account-authenticated-reviewer-response',eventId:replay.id,replayed:true,...locked};
      }
      const grant=grants(this.db).find(x=>x.id===data.grantId&&x.reviewerId===user.id);
      if(!grant||revocations(this.db).some(x=>x.grantId===data.grantId))
        throw new AppError('No active assigned review request.',403,'REVIEWER_GRANT_UNAVAILABLE');
      if(data.expectedRef!==ctx.report.snapshotRef||!matchGrant(ctx,grant))
        throw new AppError('Assigned evidence has changed; request a new grant from Owner.',409,'REVIEWER_ACK_CASE_STALE');
      const id=insertAudit(this.db,user.id,'inventory.reviewer_account_acknowledgement',{
        ...data,reviewerId:user.id,sourceHash:grant.sourceHash,
        custodyRef:grant.custodyRef,
      });
      this.db.exec('COMMIT');
      return {kind:'account-authenticated-reviewer-response',eventId:id,replayed:false,...locked};
    }catch(err){this.db.exec('ROLLBACK');throw err;}
  }
}
