import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {IndependentReviewerAccess} from '../server/independent-reviewer-access.js';

const DAY=24*60*60*1000;
const start=Date.parse('2026-11-16T09:00:00Z');
const owner={id:'owner',role:'owner'};
const reviewerId=randomUUID();
const reviewer={id:reviewerId,role:'reviewer'};
const HASH='b'.repeat(64);
const SOURCE='a'.repeat(64);
const SNAPSHOT='c'.repeat(64);
const CUSTODY='d'.repeat(64);
const physical={manifestHash:SOURCE};
const website={};

function setup(){
  const db=new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE audit(id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor TEXT NOT NULL,action TEXT NOT NULL,
    subject TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT NOT NULL,active INTEGER NOT NULL);
    CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit
    BEGIN SELECT RAISE(ABORT,'immutable'); END;
    CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit
    BEGIN SELECT RAISE(ABORT,'immutable'); END;`);
  db.prepare('INSERT INTO users(id,role,active) VALUES (?,?,1)')
    .run(reviewerId,'reviewer');
  let fileSha256=HASH;
  const intake={
    list(_physical,_website,_query,_clock,collectRows){
      const rows=[{
        reportRow:1,sku:'PRIVATE_ITEM',mayReport:true,
        custodyRequestId:11,manifestId:12,
        fileSha256,firstClaimId:13,secondClaimId:14,
        countDiscrepancyOpen:true,
      }];
      collectRows?.push(...rows);
      return {evidenceVerified:true,snapshotRef:SNAPSHOT,custodyRef:CUSTODY};
    },
  };
  const access=new IndependentReviewerAccess(db,intake);
  const input={
    reviewerId,reportRow:1,expectedRef:SNAPSHOT,
    custodyRequestId:11,manifestId:12,fileSha256:HASH,
    firstClaimId:13,secondClaimId:14,requestId:randomUUID(),
  };
  const grant=access.grant(owner,physical,website,input,start);
  assert.equal(grant.kind,'reviewer-case-grant');
  const handoff={
    grantId:grant.grantId,expectedRef:SNAPSHOT,
    identityCheckMethod:'owner_reports_known_contact_callback',
    transferChannel:'secured_external_channel',
    requestId:randomUUID(),
  };
  const issue=()=>access.issueHandoff(owner,physical,website,handoff,start);
  return {db,access,handoff,grant,issue,setFileHash:x=>{fileSha256=x;}};
}
function receipt(issue,other={}){
  return {
    handoffId:issue.handoffId,expectedRef:SNAPSHOT,
    challenge:issue.challenge,observation:'file_not_available',
    observedFileSha256:null,
    note:'Original file was not available for independent local inspection.',
    requestId:randomUUID(),...other,
  };
}
test('Phase 5.5: expired and superseded challenge fails, secret never persisted',()=>{
  const ctx=setup();try{
    const issued=ctx.issue();
    assert.equal(issued.replayed,false);
    assert.equal(issued.originalFileDeliveredByPOS,false);
    assert.equal(issued.reviewerHumanIdentityVerified,false);
    const snap=ctx.access.listAssigned(reviewer,physical,website,start);
    assert.equal(snap.cases[0].handoff.status,'awaiting_challenge');
    assert.equal(snap.cases[0].countDiscrepancyOpen,true);
    assert.doesNotMatch(JSON.stringify(snap),new RegExp(issued.challenge));
    assert.throws(()=>ctx.access.receiveHandoff(reviewer,physical,website,
      receipt(issued),start+DAY),e=>e.code==='REVIEWER_HANDOFF_EXPIRED');
    const expired=ctx.access.listAssigned(reviewer,physical,website,start+DAY);
    assert.equal(expired.cases[0].handoff.status,'expired');
    assert.throws(()=>ctx.access.issueHandoff(owner,physical,website,{
      ...ctx.handoff,requestId:randomUUID(),
    },start+DAY-1),e=>e.code==='REVIEWER_HANDOFF_ALREADY_ACTIVE');
    const newer=ctx.access.issueHandoff(owner,physical,website,{
      ...ctx.handoff,requestId:randomUUID(),
    },start+DAY);
    assert.notEqual(newer.handoffId,issued.handoffId);
    assert.notEqual(newer.challenge,issued.challenge);
    assert.throws(()=>ctx.access.receiveHandoff(reviewer,physical,website,
      receipt(issued),start+DAY+1),e=>e.code==='REVIEWER_HANDOFF_EXPIRED');
    assert.equal(ctx.access.receiveHandoff(reviewer,physical,website,
      receipt(newer),start+DAY+1).kind,'reviewer-handoff-account-receipt');
    const recorded=ctx.access.listOwner(owner,physical,website,start+DAY+1);
    assert.equal(recorded.assignments[0].handoff.status,'account_receipt_recorded');
    assert.equal(recorded.assignments[0].handoff.receipt.observation,'file_not_available');
    assert.equal(recorded.checkoutAuthorized,false);
    assert.equal(recorded.independentReviewConfirmed,false);
    assert.throws(()=>ctx.access.issueHandoff(owner,physical,website,{
      ...ctx.handoff,requestId:randomUUID(),
    },start+DAY+2),e=>e.code==='REVIEWER_HANDOFF_ALREADY_RECEIVED');
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM audit WHERE action=?')
      .get('inventory.reviewer_handoff_receipt').n,1);
    assert.equal(ctx.db.prepare('SELECT subject FROM audit WHERE action=?')
      .get('inventory.reviewer_handoff_issued').subject.includes(issued.challenge),false);
  }finally{ctx.db.close();}
});
test('Phase 5.5: revoked, stale, malformed and falsified file-claims fail closed',()=>{
  const ctx=setup();try{
    const issued=ctx.issue();
    const base=receipt(issued);
    for(const bad of [
      {...base,observation:'fingerprint_match_reported'},
      {...base,observation:'file_not_available',observedFileSha256:HASH},
      {...base,challenge:'not a challenge'},
      {...base,ownerApproved:true},
    ])assert.throws(()=>ctx.access.receiveHandoff(reviewer,physical,website,bad,start+1));
    assert.throws(()=>ctx.access.receiveHandoff(reviewer,physical,website,{
      ...base,challenge:'0'.repeat(64),
    },start+1),e=>e.code==='REVIEWER_HANDOFF_SECRET_INVALID');
    assert.throws(()=>ctx.access.receiveHandoff(reviewer,physical,website,{
      ...base,observation:'fingerprint_match_reported',
      observedFileSha256:'e'.repeat(64),
    },start+1),e=>e.code==='REVIEWER_HANDOFF_FINGERPRINT_CONFLICT');
    ctx.setFileHash('e'.repeat(64));
    assert.throws(()=>ctx.access.receiveHandoff(reviewer,physical,website,
      base,start+1),e=>e.code==='REVIEWER_HANDOFF_STALE');
    assert.equal(ctx.access.listAssigned(reviewer,physical,website,start+1)
      .cases[0].handoff.status,'inactive_or_stale');
    ctx.setFileHash(HASH);
    const revoked=ctx.access.revoke(owner,{
      grantId:ctx.grant.grantId,requestId:randomUUID(),
    });
    assert.equal(revoked.revoked,true);
    assert.throws(()=>ctx.access.receiveHandoff(reviewer,physical,website,
      base,start+1),e=>e.code==='REVIEWER_HANDOFF_NOT_ASSIGNED');
    assert.throws(()=>ctx.access.issueHandoff(owner,physical,website,{
      ...ctx.handoff,requestId:randomUUID(),
    },start+2),e=>e.code==='REVIEWER_HANDOFF_GRANT_INVALID');
    assert.equal(ctx.access.listOwner(owner,physical,website,start+2)
      .assignments[0].status,'revoked');
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM audit WHERE action=?')
      .get('inventory.reviewer_handoff_receipt').n,0);
    assert.throws(()=>ctx.db.prepare('DELETE FROM audit').run(),/immutable/);
  }finally{ctx.db.close();}
});
