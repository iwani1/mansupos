import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createApp} from '../server/app.js';
import {hashPassword} from '../server/db.js';

test('Phase 5.4 reviewer account is case-scoped, denies other POS APIs and never releases stock',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mansu-reviewer-access-'));
  const wooCalls=[];
  let wooSku='1';
  const api={
    async products(){
      wooCalls.push('products GET');
      return {data:[{id:42,type:'simple',name:'Synthetic private item',
        sku:wooSku,status:'publish',price:'100.00',stock_status:'instock',
        manage_stock:true,stock_quantity:12,purchasable:true,
        backorders:'no',images:[],categories:[]}],pages:1,total:1};
    },
    async variations(){throw new Error('No variation call expected');},
    async order(){throw new Error('No Woo order access allowed');},
    async createOrder(){throw new Error('No Woo order creation allowed');},
    async updateOrder(){throw new Error('No Woo order update allowed');},
  };
  const env={
    NODE_ENV:'test',POS_MODE:'live',POS_LIVE_READ_ONLY:'true',
    POS_ALLOW_LIVE_WRITES:'false',WOO_BASE_URL:'https://mansutrendzgh.com',
    WOO_CONSUMER_KEY:'ck_synthetic',WOO_CONSUMER_SECRET:'cs_synthetic',
    POS_PUBLIC_ORIGIN:'https://pos.mansutrendzgh.com',
    POS_DATA_DIR:dir,POS_OWNER_USERNAME:'owner',
    POS_OWNER_PASSWORD:'synthetic-reviewer-setup-123',
  };
  const {app,db,inStore}=createApp({env,api,logger:{
    debug(){},info(){},warn(){},error(){},
  }});
  for(const [name,role] of [['review-counter-one','cashier'],['review-counter-two','manager']]){
    db.prepare('INSERT INTO users(id,username,name,role,password_hash,active,created_at,must_change_password) VALUES(?,?,?,?,?,1,?,0)')
      .run(randomUUID(),name,name,role,hashPassword('synthetic-counter-password-123'),new Date().toISOString());
  }
  const server=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  t.after(async()=>{
    await new Promise(resolve=>server.close(resolve));
    db.close();fs.rmSync(dir,{recursive:true,force:true});
  });
  const base='http://127.0.0.1:'+server.address().port+'/api';
  const req=async(url,token=null,method='GET',body)=>{
    const response=await fetch(base+url,{method,
      headers:{'Content-Type':'application/json',
        ...(token?{Authorization:'Bearer '+token}:{})},
      ...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {status:response.status,data:await response.json()};
  };
  const ownerLogin=await req('/auth/login',null,'POST',{
    username:'owner',password:'synthetic-reviewer-setup-123',
  });
  assert.equal(ownerLogin.status,200);
  const owner=ownerLogin.data.token;
  assert.equal((await req('/auth/password',owner,'POST',{
    currentPassword:'synthetic-reviewer-setup-123',
    newPassword:'synthetic-rotated-login-1234',
  })).status,200);
  const counter1=(await req('/auth/login',null,'POST',{
    username:'review-counter-one',password:'synthetic-counter-password-123',
  })).data.token;
  const counter2=(await req('/auth/login',null,'POST',{
    username:'review-counter-two',password:'synthetic-counter-password-123',
  })).data.token;
  const source=inStore.snapshot().items.find(x=>x.status==='available'&&x.sku);
  assert.ok(source,'Synthetic historical source must include an eligible row.');
  wooSku=source.sku;
  const work=await req('/stock-safety/count-worklist?search='+encodeURIComponent(source.sku),counter1);
  assert.equal(work.status,200);
  const row=work.data.items.find(x=>x.sku===source.sku);
  assert.ok(row);
  assert.equal((await req('/stock-safety/count-claim',counter1,'POST',{
    reportRow:row.reportRow,stage:'first',units:8,
    expectedRef:work.data.snapshotRef,requestId:randomUUID(),
  })).status,201);
  const work2=await req('/stock-safety/count-worklist?search='+encodeURIComponent(source.sku),counter2);
  assert.equal((await req('/stock-safety/count-claim',counter2,'POST',{
    reportRow:row.reportRow,stage:'second',units:9,
    expectedRef:work2.data.snapshotRef,requestId:randomUUID(),
  })).status,201);
  const manifest=await req('/stock-safety/count-file-manifests?search='+encodeURIComponent(source.sku),owner);
  assert.equal(manifest.status,200);
  const fileRow=manifest.data.items.find(x=>x.reportRow===row.reportRow);
  assert.ok(fileRow);
  assert.equal((await req('/stock-safety/count-file-manifests',owner,'POST',{
    reportRow:row.reportRow,expectedRef:manifest.data.snapshotRef,
    expectedLatestManifestId:null,firstClaimId:fileRow.firstClaimId,
    secondClaimId:fileRow.secondClaimId,documentCode:'PRIVATE_DOC_001',
    documentType:'count_sheet',mime:'application/pdf',
    fileBytes:123,fileSha256:'b'.repeat(64),requestId:randomUUID(),
  })).status,201);
  const custodyUrl='/stock-safety/evidence-custody';
  let c=await req(custodyUrl+'?search='+encodeURIComponent(source.sku),owner);
  let cr=c.data.items.find(x=>x.reportRow===row.reportRow);
  const seal={
    reportRow:row.reportRow,expectedRef:c.data.snapshotRef,
    expectedLatestEventId:null,manifestId:cr.manifest.id,
    fileSha256:cr.manifest.fileSha256,firstClaimId:cr.firstClaimId,
    secondClaimId:cr.secondClaimId,
    action:'sealed_in_private_custody',locationCode:'PRIVATE_BOX_01',
    reviewChannel:'none',note:'Owner recorded custody of physical count paper.',
    requestId:randomUUID(),
  };
  assert.equal((await req(custodyUrl,owner,'POST',seal)).status,201);
  c=await req(custodyUrl+'?search='+encodeURIComponent(source.sku),owner);
  cr=c.data.items.find(x=>x.reportRow===row.reportRow);
  assert.equal((await req(custodyUrl,owner,'POST',{
    ...seal,expectedRef:c.data.snapshotRef,
    expectedLatestEventId:cr.latestCustodyEvent.id,
    action:'independent_review_requested',reviewChannel:'in_person',
    note:'Please examine the separately held physical original.',
    requestId:randomUUID(),
  })).status,201);
  const accountUrl='/stock-safety/reviewer-access';
  assert.equal((await req(accountUrl)).status,401);
  assert.equal((await req(accountUrl,counter1)).status,403);
  assert.equal((await req(accountUrl+'/accounts',counter2,'POST',{
    username:'review.external1',
  })).status,403);
  assert.equal((await req('/reviewer/cases',owner)).status,403);
  const created=await req(accountUrl+'/accounts',owner,'POST',{
    username:'review.external1',
  });
  assert.equal(created.status,201);
  assert.equal(created.data.kind,'reviewer-account-created');
  assert.equal(created.data.mustChangePassword,true);
  assert.ok(created.data.temporaryPassword.length>=24);
  assert.equal(created.data.humanIdentityVerified,false);
  assert.equal((await req(accountUrl+'/accounts',owner,'POST',{
    username:'review.external1',
  })).status,409);
  const reviewerLogin=await req('/auth/login',null,'POST',{
    username:created.data.username,password:created.data.temporaryPassword,
  });
  assert.equal(reviewerLogin.status,200);
  assert.equal(reviewerLogin.data.user.role,'reviewer');
  const reviewer=reviewerLogin.data.token;
  assert.equal((await req('/reviewer/cases',reviewer)).status,403,
    'Temporary reviewer password must be changed before accessing grants.');
  assert.equal((await req('/auth/password',reviewer,'POST',{
    currentPassword:created.data.temporaryPassword,
    newPassword:'synthetic-external-reviewer-strong-123',
  })).status,200);
  for(const endpoint of [
    '/catalog','/sales','/staff','/operations/team',
    '/shifts/current','/stock-safety/reviewer-responses',
    '/stock-safety/reviewer-access','/stock-safety/count-worklist',
    '/stock-safety/count-claims-review',
  ])assert.equal((await req(endpoint,reviewer)).status,403,
    'Reviewer must be denied '+endpoint);
  for(const endpoint of ['/sales/prepare','/stock-safety/count-claim',
    '/stock-safety/count-owner-triage','/stock-safety/reviewer-access/grants']){
    assert.equal((await req(endpoint,reviewer,'POST',{})).status,403,
      'Reviewer must not mutate '+endpoint);
  }
  const before=await req('/reviewer/cases',reviewer);
  assert.equal(before.status,200);
  assert.deepEqual(before.data.cases,[]);
  const ownerCases=await req(accountUrl,owner);
  assert.equal(ownerCases.status,200);
  const eligible=ownerCases.data.cases.find(x=>x.reportRow===row.reportRow);
  assert.ok(eligible,'Case must have current evidence and review request.');
  assert.equal(eligible.countDiscrepancyOpen,true);
  const grantBody={
    reviewerId:created.data.reviewerId,reportRow:row.reportRow,
    expectedRef:ownerCases.data.snapshotRef,
    custodyRequestId:eligible.custodyRequestId,
    manifestId:eligible.manifestId,fileSha256:eligible.fileSha256,
    firstClaimId:eligible.firstClaimId,secondClaimId:eligible.secondClaimId,
    requestId:randomUUID(),
  };
  assert.equal((await req(accountUrl+'/grants',owner,'POST',{
    ...grantBody,fileSha256:'0'.repeat(64),
  })).status,409);
  const grant=await req(accountUrl+'/grants',owner,'POST',grantBody);
  assert.equal(grant.status,201);
  assert.equal(grant.data.kind,'reviewer-case-grant');
  assert.equal(grant.data.stockImportAuthorized,false);
  assert.equal((await req(accountUrl+'/grants',owner,'POST',grantBody)).data.replayed,true);
  const assigned=await req('/reviewer/cases',reviewer);
  assert.equal(assigned.status,200);
  assert.equal(assigned.data.kind,'reviewer-assigned-request-metadata');
  assert.equal(assigned.data.cases.length,1);
  assert.equal(assigned.data.cases[0].grantId,grant.data.grantId);
  assert.equal(assigned.data.cases[0].countDiscrepancyOpen,true);
  assert.equal(assigned.data.cases[0].mayAcknowledge,true);
  assert.equal(assigned.data.independentReviewConfirmed,false);
  assert.equal(assigned.data.stockImportAuthorized,false);
  assert.equal(assigned.data.checkoutAuthorized,false);
  assert.doesNotMatch(JSON.stringify(assigned.data),
    /Synthetic private item|priceCents|firstUnits|secondUnits|cashier_name|customerEmail/);
  // Keep API test below the existing 30/minute sensitive-action rate limit;
  // reviewer isolation is checked before that limiter, which stays unchanged.
  // Phase 5.5: Owner sends no document through the POS. A single-use,
  // 256-bit out-of-band challenge can be confirmed by the assigned account.
  // Human identity, physical witnessing, original provenance and trading
  // approval remain explicitly UNVERIFIED.
  const handoffUrl=accountUrl+'/handoff';
  const receiptUrl='/reviewer/handoff-receipt';
  const handoffBody={
    grantId:grant.data.grantId,expectedRef:assigned.data.snapshotRef,
    identityCheckMethod:'owner_reports_in_person_check',
    transferChannel:'in_person',requestId:randomUUID(),
  };
  assert.equal((await req(handoffUrl,reviewer,'POST',handoffBody)).status,403);
  assert.equal((await req(handoffUrl,counter1,'POST',handoffBody)).status,403);
  assert.equal((await req(handoffUrl,null,'POST',handoffBody)).status,401);
  const issued=await req(handoffUrl,owner,'POST',handoffBody);
  assert.equal(issued.status,201);
  assert.equal(issued.data.kind,'reviewer-handoff-challenge');
  assert.match(issued.data.challenge,/^[a-f0-9]{64}$/);
  assert.equal(issued.data.reviewerHumanIdentityVerified,false);
  assert.equal(issued.data.originalFileDeliveredByPOS,false);
  assert.equal(issued.data.stockImportAuthorized,false);
  const replayIssue=await req(handoffUrl,owner,'POST',handoffBody);
  assert.equal(replayIssue.status,201);
  assert.equal(replayIssue.data.replayed,true);
  assert.equal(replayIssue.data.challenge,null);
  assert.equal((await req(handoffUrl,owner,'POST',{
    ...handoffBody,requestId:randomUUID(),
  })).status,409);
  const assignedWithChallenge=await req('/reviewer/cases',reviewer);
  assert.equal(assignedWithChallenge.status,200);
  const challengeCase=assignedWithChallenge.data.cases[0];
  assert.equal(challengeCase.handoff.id,issued.data.handoffId);
  assert.equal(challengeCase.handoff.status,'awaiting_challenge');
  assert.equal(challengeCase.handoff.humanIdentityVerified,false);
  assert.doesNotMatch(JSON.stringify(assignedWithChallenge.data),
    new RegExp(issued.data.challenge));
  assert.doesNotMatch(JSON.stringify(assignedWithChallenge.data),/secretDigest/);
  const receiptBody={
    handoffId:issued.data.handoffId,
    expectedRef:assignedWithChallenge.data.snapshotRef,
    challenge:issued.data.challenge,
    observation:'fingerprint_match_reported',
    observedFileSha256:'b'.repeat(64),
    note:'I compared the local file digest; originality and count accuracy remain unchecked.',
    requestId:randomUUID(),
  };
  assert.equal((await req(receiptUrl,owner,'POST',receiptBody)).status,403);
  assert.equal((await req(receiptUrl,counter1,'POST',receiptBody)).status,403);
  assert.equal((await req(receiptUrl,reviewer,'POST',{
    ...receiptBody,challenge:'0'.repeat(64),
  })).status,403);
  assert.equal((await req(receiptUrl,reviewer,'POST',{
    ...receiptBody,humanIdentityVerified:true,
  })).status,400);
  const received=await req(receiptUrl,reviewer,'POST',receiptBody);
  assert.equal(received.status,201);
  assert.equal(received.data.kind,'reviewer-handoff-account-receipt');
  assert.equal(received.data.challengePossessionConfirmed,true);
  assert.equal(received.data.originalFileDeliveredByPOS,false);
  assert.equal(received.data.humanIdentityVerified,false);
  assert.equal(received.data.checkoutAuthorized,false);
  const replayReceipt=await req(receiptUrl,reviewer,'POST',receiptBody);
  assert.equal(replayReceipt.data.replayed,true);
  assert.equal(replayReceipt.data.eventId,received.data.eventId);
  assert.equal((await req(receiptUrl,reviewer,'POST',{
    ...receiptBody,requestId:randomUUID(),
  })).status,409);
  assert.equal((await req(receiptUrl,reviewer,'POST',{
    ...receiptBody,note:'Modified note but same request identifier.',
  })).status,409);
  assert.equal((await req(handoffUrl,owner,'POST',{
    ...handoffBody,requestId:randomUUID(),
  })).status,409);
  const ownerAfterHandoff=await req(accountUrl,owner);
  const ownerHandoff=ownerAfterHandoff.data.assignments.find(x=>x.grantId===grant.data.grantId);
  assert.equal(ownerHandoff.handoff.status,'account_receipt_recorded');
  assert.equal(ownerHandoff.handoff.receipt.observation,'fingerprint_match_reported');
  assert.equal(ownerHandoff.handoff.receipt.humanIdentityVerified,false);
  assert.equal(ownerAfterHandoff.data.independentReviewConfirmed,false);
  assert.equal(ownerAfterHandoff.data.stockImportAuthorized,false);
  assert.equal(ownerAfterHandoff.data.checkoutAuthorized,false);
  const auditHandoff=db.prepare("SELECT subject FROM audit WHERE action='inventory.reviewer_handoff_issued'").get();
  assert.ok(auditHandoff);
  assert.equal(auditHandoff.subject.includes(issued.data.challenge),false,
    'The one-time challenge must never be stored in the journal.');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='inventory.reviewer_handoff_issued'").get().n,1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='inventory.reviewer_handoff_receipt'").get().n,1);
  const ackBody={
    grantId:grant.data.grantId,expectedRef:assigned.data.snapshotRef,
    outcome:'evidence_issue_reported',issueCode:'count_numbers_conflict',
    note:'Two staff counts differ and the original must be independently inspected.',
    requestId:randomUUID(),
  };
  assert.equal((await req('/reviewer/acknowledgements',owner,'POST',ackBody)).status,403);
  assert.equal((await req('/reviewer/acknowledgements',reviewer,'POST',{
    ...ackBody,approveInventory:true,
  })).status,400);
  assert.equal((await req('/reviewer/acknowledgements',reviewer,'POST',{
    ...ackBody,expectedRef:'0'.repeat(64),
  })).status,409);
  const acknowledged=await req('/reviewer/acknowledgements',reviewer,'POST',ackBody);
  assert.equal(acknowledged.status,201);
  assert.equal(acknowledged.data.kind,'account-authenticated-reviewer-response');
  assert.equal(acknowledged.data.reviewerHumanIdentityVerified,false);
  assert.equal(acknowledged.data.independentReviewConfirmed,false);
  assert.equal(acknowledged.data.checkoutAuthorized,false);
  assert.equal((await req('/reviewer/acknowledgements',reviewer,'POST',ackBody)).data.replayed,true);
  const updated=await req(accountUrl,owner);
  const assignedCase=updated.data.assignments.find(x=>x.grantId===grant.data.grantId);
  assert.equal(assignedCase.latestAcknowledgement.outcome,'evidence_issue_reported');
  assert.equal(assignedCase.countDiscrepancyOpen,true);
  assert.equal(updated.data.independentReviewConfirmed,false);
  const revoked=await req(accountUrl+'/revoke',owner,'POST',{
    grantId:grant.data.grantId,requestId:randomUUID(),
  });
  assert.equal(revoked.status,200);
  assert.equal(revoked.data.revoked,true);
  assert.equal((await req('/reviewer/acknowledgements',reviewer,'POST',{
    ...ackBody,requestId:randomUUID(),
  })).status,403);
  const after=await req('/reviewer/cases',reviewer);
  assert.equal(after.data.cases[0].status,'revoked');
  assert.equal(after.data.cases[0].mayAcknowledge,false);
  // Phase 5.6: Owner sees unresolved evidence across count and reviewer
  // reports; reviewer/staff sessions cannot query or write the hold queue.
  const exceptionsUrl='/stock-safety/evidence-exceptions';
  assert.equal((await req(exceptionsUrl,counter1)).status,403);
  assert.equal((await req(exceptionsUrl,reviewer)).status,403);
  assert.equal((await req(exceptionsUrl)).status,401);
  assert.equal((await req(exceptionsUrl+'/followup',reviewer,'POST',{})).status,403);
  const exceptions=await req(exceptionsUrl+'?search='+encodeURIComponent(source.sku),owner);
  assert.equal(exceptions.status,200);
  assert.equal(exceptions.data.kind,'owner-inventory-evidence-exception-queue');
  const openCase=exceptions.data.items.find(x=>x.reportRow===row.reportRow);
  assert.ok(openCase,'A current disputed source must be in the Owner hold queue.');
  assert.equal(openCase.category,'count_disagreement');
  assert.equal(openCase.countDiscrepancyOpen,true);
  assert.equal(openCase.caseClosed,false);
  assert.equal(exceptions.data.checkoutAuthorized,false);
  assert.equal(exceptions.data.stockImportAuthorized,false);
  assert.equal(exceptions.data.summary.approvedCases,0);
  assert.equal((await req(exceptionsUrl+'?status=approved',owner)).status,400);
  assert.equal((await req(exceptionsUrl+'?expectedRef='+('0'.repeat(64)),owner)).status,409);
  // Phase 5.7: readiness is an Owner-only GET analysis; a real reviewer
  // acknowledgement and file fingerprint NEVER authorize any stock or sale.
  const readinessUrl='/stock-safety/verification-readiness';
  assert.equal((await req(readinessUrl,reviewer)).status,403);
  assert.equal((await req(readinessUrl,counter1)).status,403);
  assert.equal((await req(readinessUrl)).status,401);
  const readiness=await req(readinessUrl+'?search='+encodeURIComponent(source.sku),owner);
  assert.equal(readiness.status,200);
  assert.equal(readiness.data.kind,'owner-inventory-verification-readiness');
  assert.equal(readiness.data.stockImportAuthorized,false);
  assert.equal(readiness.data.checkoutAuthorized,false);
  assert.equal(readiness.data.releaseReady,false);
  assert.equal(readiness.data.summary.acceptedRows,0);
  const heldReadiness=readiness.data.items.find(x=>x.reportRow===row.reportRow);
  assert.ok(heldReadiness,'Disputed physical row must appear in readiness report.');
  assert.equal(heldReadiness.staffCountDiscrepancyOpen,true);
  assert.equal(heldReadiness.readiness,'blocked');
  assert.equal(heldReadiness.stockImportAuthorized,false);
  assert.ok(heldReadiness.criteria.every(x=>x.independentlyVerified===false));
  assert.equal((await req(readinessUrl+'?focus=approved',owner)).status,400);
  assert.equal((await req(readinessUrl+'?expectedRef='+('0'.repeat(64)),owner)).status,409);
  const ownerCounts=await req('/stock-safety/count-claims-review?search='+encodeURIComponent(source.sku),owner);
  assert.equal(ownerCounts.data.items[0].stage,'discrepant_claims');
  assert.equal(ownerCounts.data.checkoutAuthorized,false);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='inventory.reviewer_access_granted'").get().n,1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='inventory.reviewer_account_acknowledgement'").get().n,1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='inventory.reviewer_access_revoked'").get().n,1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM instore_sales').get().n,0);
  assert.ok(wooCalls.length>0);
  assert.ok(wooCalls.every(x=>x==='products GET'));
});
