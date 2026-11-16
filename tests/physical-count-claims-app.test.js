import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createApp} from '../server/app.js';
import {hashPassword} from '../server/db.js';

test('count-claim API: auth, blind independent staff entries, owner-only review and zero Woo writes',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mansu-count-claims-'));
  const log=[];
  let sku='1';
  const api={
    async products(){
      log.push('Woo GET products');
      return {data:[{id:90,type:'simple',name:'Synthetic',sku,status:'publish',
        price:'100.00',stock_status:'instock',manage_stock:true,stock_quantity:10,
        purchasable:true,backorders:'no',images:[],categories:[]}],pages:1,total:1};
    },
    async variations(){throw new Error('Unexpected Woo variation request');},
    async order(){throw new Error('Woo orders must not be inspected');},
    async createOrder(){throw new Error('Woo orders must not be written');},
    async updateOrder(){throw new Error('Woo stock must not be written');},
  };
  const env={
    NODE_ENV:'test',POS_MODE:'live',POS_LIVE_READ_ONLY:'true',
    POS_ALLOW_LIVE_WRITES:'false',WOO_BASE_URL:'https://mansutrendzgh.com',
    WOO_CONSUMER_KEY:'ck_synthetic',WOO_CONSUMER_SECRET:'cs_synthetic',
    POS_PUBLIC_ORIGIN:'https://pos.mansutrendzgh.com',
    POS_DATA_DIR:dir,POS_OWNER_USERNAME:'owner',
    POS_OWNER_PASSWORD:'synthetic-pilot-password-123',
  };
  const {app,db,catalog,inStore}=createApp({env,api,logger:{
    debug(){},info(){},warn(){},error(){},
  }});
  const firstSku=inStore.snapshot().items.find(item=>item.status==='available'&&item.sku);
  assert.ok(firstSku);
  sku=firstSku.sku;
  for(const [name,role] of [['counter1','cashier'],['counter2','manager']]){
    db.prepare(`INSERT INTO users(id,username,name,role,password_hash,active,created_at,must_change_password)
      VALUES(?,?,?,?,?,1,?,0)`).run(
      randomUUID(),name,name,role,hashPassword('synthetic-password-for-'+name),
      new Date().toISOString()
    );
  }
  const server=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  t.after(async()=>{
    await new Promise(resolve=>server.close(resolve));
    db.close();
    fs.rmSync(dir,{recursive:true,force:true});
  });
  const base='http://127.0.0.1:'+server.address().port+'/api';
  async function req(url,token=null,method='GET',body){
    const response=await fetch(base+url,{method,
      headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},
      ...(body?{body:JSON.stringify(body)}:{})});
    return {status:response.status,data:await response.json()};
  }
  const ownerLogin=await req('/auth/login',null,'POST',
    {username:'owner',password:'synthetic-pilot-password-123'});
  assert.equal(ownerLogin.status,200);
  const ownerToken=ownerLogin.data.token;
  assert.equal((await req('/auth/password',ownerToken,'POST',{
    currentPassword:'synthetic-pilot-password-123',
    newPassword:'synthetic-rotated-password-123',
  })).status,200);
  const one=await req('/auth/login',null,'POST',{
    username:'counter1',password:'synthetic-password-for-counter1',
  });
  const two=await req('/auth/login',null,'POST',{
    username:'counter2',password:'synthetic-password-for-counter2',
  });
  assert.equal(one.status,200);
  assert.equal(two.status,200);
  assert.equal((await req('/stock-safety/count-worklist')).status,401);
  assert.equal((await req('/stock-safety/count-claims-review',one.data.token)).status,403);
  assert.equal((await req('/stock-safety/count-claim',ownerToken,'POST',{})).status,403);
  const staffList=await req('/stock-safety/count-worklist?search='+encodeURIComponent(sku),one.data.token);
  assert.equal(staffList.status,200);
  assert.equal(staffList.data.kind,'local-unverified-physical-count-worklist');
  assert.equal(staffList.data.items[0].canSubmit,true);
  assert.equal(staffList.data.items[0].stage,'first_needed');
  const row=staffList.data.items[0].reportRow;
  const body={
    reportRow:row,stage:'first',units:7,
    expectedRef:staffList.data.snapshotRef,
    requestId:randomUUID(),
  };
  const result=await req('/stock-safety/count-claim',one.data.token,'POST',body);
  assert.equal(result.status,201);
  assert.equal(result.data.recorded,true);
  assert.equal(result.data.stockImportAuthorized,false);
  assert.equal((await req('/stock-safety/count-claim',one.data.token,'POST',body)).data.replayed,true);
  const secondView=await req('/stock-safety/count-worklist?search='+encodeURIComponent(sku),two.data.token);
  assert.equal(secondView.data.items[0].stage,'second_needed');
  assert.equal(secondView.data.items[0].canSubmit,true);
  assert.equal(JSON.stringify(secondView.data).includes('firstUnits'),false);
  assert.equal(JSON.stringify(secondView.data).includes('counter1'),false);
  assert.equal((await req('/stock-safety/count-claim',one.data.token,'POST',{
    ...body,stage:'second',requestId:randomUUID(),
  })).status,403);
  const second=await req('/stock-safety/count-claim',two.data.token,'POST',{
    ...body,stage:'second',units:9,requestId:randomUUID(),
  });
  assert.equal(second.status,201);
  const supervisorUrl='/stock-safety/count-supervision';
  assert.equal((await req(supervisorUrl)).status,401);
  assert.equal((await req(supervisorUrl,one.data.token)).status,403);
  assert.equal((await req(supervisorUrl,two.data.token)).status,403);
  const supervisor=await req(supervisorUrl+'?search='+encodeURIComponent(sku),ownerToken);
  assert.equal(supervisor.status,200);
  assert.equal(supervisor.data.kind,'local-count-supervision-evidence');
  const supervisorCase=supervisor.data.items.find(x=>x.reportRow===row);
  assert.ok(supervisorCase);
  assert.equal(supervisorCase.status,'count_discrepancy_open');
  assert.equal(supervisorCase.firstCounterAccountId!=null,true);
  assert.equal(supervisorCase.secondCounterAccountId!=null,true);
  assert.equal(supervisor.data.physicallyWitnessed,false);
  assert.equal(supervisor.data.independentWitnessVerified,false);
  assert.equal(supervisor.data.stockImportAuthorized,false);
  assert.equal(supervisor.data.checkoutAuthorized,false);
  const evidenceBody={
    reportRow:row,expectedRef:supervisor.data.snapshotRef,
    firstClaimId:supervisorCase.firstClaimId,
    secondClaimId:supervisorCase.secondClaimId,
    expectedLatestNoteId:null,
    action:'flag_discrepancy',documentCode:'COUNT_NOV_001',
    note:'Discrepant counts require a supervised recount.',
    requestId:randomUUID(),
  };
  assert.equal((await req(supervisorUrl,one.data.token,'POST',evidenceBody)).status,403);
  assert.equal((await req(supervisorUrl,two.data.token,'POST',evidenceBody)).status,403);
  assert.equal((await req(supervisorUrl,null,'POST',evidenceBody)).status,401);
  const recorded=await req(supervisorUrl,ownerToken,'POST',evidenceBody);
  assert.equal(recorded.status,201);
  assert.equal(recorded.data.kind,'unverified-count-supervision-note');
  assert.equal(recorded.data.recorded,true);
  assert.equal(recorded.data.independentWitnessVerified,false);
  assert.equal(recorded.data.stockImportAuthorized,false);
  assert.equal((await req(supervisorUrl,ownerToken,'POST',evidenceBody)).data.replayed,true);
  const supervisorNext=await req(supervisorUrl+'?search='+encodeURIComponent(sku),ownerToken);
  assert.equal(supervisorNext.status,200);
  const updatedCase=supervisorNext.data.items.find(x=>x.reportRow===row);
  assert.ok(updatedCase);
  assert.equal(updatedCase.status,'count_discrepancy_open');
  assert.equal(updatedCase.latestNote.documentCode,'COUNT_NOV_001');
  assert.notEqual(supervisorNext.data.snapshotRef,supervisor.data.snapshotRef);
  assert.equal((await req(supervisorUrl+'?expectedRef='+supervisor.data.snapshotRef,ownerToken)).status,409);
  assert.equal((await req(supervisorUrl,ownerToken,'POST',{
    ...evidenceBody,requestId:randomUUID(),action:'approve_inventory',
  })).status,400);
  assert.equal((await req(supervisorUrl,ownerToken,'POST',{
    ...evidenceBody,requestId:randomUUID(),
  })).status,409);
  assert.equal((await req(supervisorUrl+'?status=approved',ownerToken)).status,400);
  assert.equal((await req(supervisorUrl+'?unknown=1',ownerToken)).status,400);
  assert.equal((await req(supervisorUrl,ownerToken,'POST',{approve:true})).status,400);
  // Metadata-only file manifest: strict Owner role, no document bytes or
  // Woo stock writes. A discrepancy MUST remain open after recording a hash.
  const manifestUrl='/stock-safety/count-file-manifests';
  assert.equal((await req(manifestUrl)).status,401);
  assert.equal((await req(manifestUrl,one.data.token)).status,403);
  assert.equal((await req(manifestUrl,two.data.token)).status,403);
  const manifestBefore=await req(manifestUrl+'?search='+encodeURIComponent(sku),ownerToken);
  assert.equal(manifestBefore.status,200);
  assert.equal(manifestBefore.data.kind,'owner-private-count-file-manifest-review');
  const evidenceRow=manifestBefore.data.items.find(x=>x.reportRow===row);
  assert.ok(evidenceRow);
  assert.equal(evidenceRow.status,'count_discrepancy_open');
  assert.equal(evidenceRow.mayRecord,true);
  assert.equal(manifestBefore.data.documentContentUploaded,false);
  assert.equal(manifestBefore.data.independentWitnessVerified,false);
  const manifestInput={
    reportRow:row,expectedRef:manifestBefore.data.snapshotRef,
    expectedLatestManifestId:null,
    firstClaimId:evidenceRow.firstClaimId,
    secondClaimId:evidenceRow.secondClaimId,
    documentCode:'PRIVATE_COUNT_2026_01',
    documentType:'count_sheet',
    mime:'application/pdf',fileBytes:31,
    fileSha256:'b'.repeat(64),requestId:randomUUID(),
  };
  assert.equal((await req(manifestUrl,one.data.token,'POST',manifestInput)).status,403);
  assert.equal((await req(manifestUrl,two.data.token,'POST',manifestInput)).status,403);
  assert.equal((await req(manifestUrl,null,'POST',manifestInput)).status,401);
  assert.equal((await req(manifestUrl,ownerToken,'POST',{
    ...manifestInput,rawFile:'%PDF fake bytes',
  })).status,400);
  const manifestSaved=await req(manifestUrl,ownerToken,'POST',manifestInput);
  assert.equal(manifestSaved.status,201);
  assert.equal(manifestSaved.data.recorded,true);
  assert.equal(manifestSaved.data.documentContentUploaded,false);
  assert.equal(manifestSaved.data.stockImportAuthorized,false);
  assert.equal(manifestSaved.data.checkoutAuthorized,false);
  assert.equal((await req(manifestUrl,ownerToken,'POST',manifestInput)).data.replayed,true);
  const manifestAfter=await req(manifestUrl+'?search='+encodeURIComponent(sku),ownerToken);
  assert.equal(manifestAfter.status,200);
  const manifestCase=manifestAfter.data.items.find(x=>x.reportRow===row);
  assert.ok(manifestCase);
  assert.equal(manifestCase.status,'count_discrepancy_open');
  assert.equal(manifestCase.latestManifest.fileSha256,'b'.repeat(64));
  assert.equal(manifestCase.latestManifest.signatureVerified,false);
  assert.notEqual(manifestAfter.data.snapshotRef,manifestBefore.data.snapshotRef);
  assert.equal((await req(manifestUrl+'?expectedRef='+manifestBefore.data.snapshotRef,ownerToken)).status,409);
  assert.equal((await req(manifestUrl,ownerToken,'POST',{
    ...manifestInput,requestId:randomUUID(),
  })).status,409);
  assert.equal((await req(manifestUrl,ownerToken,'POST',{
    ...manifestInput,requestId:randomUUID(),approved:true,
  })).status,400);
  assert.equal((await req(manifestUrl+'?status=approved',ownerToken)).status,400);
  assert.equal((await req(manifestUrl+'?unexpected=1',ownerToken)).status,400);
  // Phase 5.2: owner custody/reviewer handoff requests are local metadata,
  // never witness acknowledgements or proof of original-file custody.
  const custodyUrl='/stock-safety/evidence-custody';
  assert.equal((await req(custodyUrl)).status,401);
  assert.equal((await req(custodyUrl,one.data.token)).status,403);
  assert.equal((await req(custodyUrl,two.data.token)).status,403);
  const custodyStart=await req(custodyUrl+'?search='+encodeURIComponent(sku),ownerToken);
  assert.equal(custodyStart.status,200);
  assert.equal(custodyStart.data.kind,'owner-unverified-evidence-custody');
  const custodyRow=custodyStart.data.items.find(x=>x.reportRow===row);
  assert.ok(custodyRow);
  assert.equal(custodyRow.countDiscrepancyOpen,true);
  assert.equal(custodyRow.status,'count_discrepancy_open');
  assert.equal(custodyRow.mayRecord,true);
  assert.equal(custodyStart.data.independentReviewConfirmed,false);
  const custodyInput={
    reportRow:row,expectedRef:custodyStart.data.snapshotRef,
    expectedLatestEventId:null,manifestId:custodyRow.manifest.id,
    fileSha256:custodyRow.manifest.fileSha256,
    firstClaimId:custodyRow.firstClaimId,secondClaimId:custodyRow.secondClaimId,
    action:'sealed_in_private_custody',locationCode:'SEALED_BOX_01',
    reviewChannel:'none',
    note:'Original paper count sheet reportedly stored in a secure cabinet.',
    requestId:randomUUID(),
  };
  assert.equal((await req(custodyUrl,one.data.token,'POST',custodyInput)).status,403);
  assert.equal((await req(custodyUrl,two.data.token,'POST',custodyInput)).status,403);
  assert.equal((await req(custodyUrl,null,'POST',custodyInput)).status,401);
  assert.equal((await req(custodyUrl,ownerToken,'POST',{
    ...custodyInput,approval:true,
  })).status,400);
  assert.equal((await req(custodyUrl,ownerToken,'POST',{
    ...custodyInput,action:'independent_review_requested',
    reviewChannel:'in_person',requestId:randomUUID(),
  })).status,409,'An independent-review request requires a prior seal declaration');
  const custodyFirst=await req(custodyUrl,ownerToken,'POST',custodyInput);
  assert.equal(custodyFirst.status,201);
  assert.equal(custodyFirst.data.recorded,true);
  assert.equal(custodyFirst.data.documentBytesStored,false);
  assert.equal(custodyFirst.data.independentReviewConfirmed,false);
  assert.equal(custodyFirst.data.stockImportAuthorized,false);
  assert.equal((await req(custodyUrl,ownerToken,'POST',custodyInput)).data.replayed,true);
  const custodyNext=await req(custodyUrl+'?search='+encodeURIComponent(sku),ownerToken);
  assert.equal(custodyNext.status,200);
  const custodyCase=custodyNext.data.items.find(x=>x.reportRow===row);
  assert.ok(custodyCase);
  assert.equal(custodyCase.status,'count_discrepancy_open');
  assert.equal(custodyCase.latestCustodyEvent.action,'sealed_in_private_custody');
  assert.notEqual(custodyNext.data.snapshotRef,custodyStart.data.snapshotRef);
  assert.equal((await req(custodyUrl+'?expectedRef='+custodyStart.data.snapshotRef,ownerToken)).status,409);
  assert.equal((await req(custodyUrl,ownerToken,'POST',{
    ...custodyInput,requestId:randomUUID(),
  })).status,409);
  const handoff=await req(custodyUrl,ownerToken,'POST',{
    ...custodyInput,expectedRef:custodyNext.data.snapshotRef,
    expectedLatestEventId:custodyCase.latestCustodyEvent.id,
    action:'independent_review_requested',reviewChannel:'in_person',
    note:'Request an independent inspection of the privately held original.',
    requestId:randomUUID(),
  });
  assert.equal(handoff.status,201);
  const afterHandoff=await req(custodyUrl+'?search='+encodeURIComponent(sku),ownerToken);
  const handoffRow=afterHandoff.data.items.find(x=>x.reportRow===row);
  assert.equal(handoffRow.status,'count_discrepancy_open');
  assert.equal(handoffRow.latestCustodyEvent.action,'independent_review_requested');
  assert.equal(handoffRow.latestCustodyEvent.independentReviewConfirmed,false);
  assert.equal(afterHandoff.data.ownerApproved,false);
  assert.equal(afterHandoff.data.stockImportAuthorized,false);
  assert.equal((await req(custodyUrl+'?status=approved',ownerToken)).status,400);
  assert.equal((await req(custodyUrl+'?unknown=1',ownerToken)).status,400);
  // Phase 5.3: Owner-reported external response only. A reviewer has not
  // authenticated in the POS; reported receipt never resolves count disputes.
  const responseUrl='/stock-safety/reviewer-responses';
  assert.equal((await req(responseUrl)).status,401);
  assert.equal((await req(responseUrl,one.data.token)).status,403);
  assert.equal((await req(responseUrl,two.data.token)).status,403);
  const reportedBefore=await req(responseUrl+'?search='+encodeURIComponent(sku),ownerToken);
  assert.equal(reportedBefore.status,200);
  assert.equal(reportedBefore.data.kind,'owner-reported-external-reviewer-intake');
  const responseRow=reportedBefore.data.items.find(x=>x.reportRow===row);
  assert.ok(responseRow);
  assert.equal(responseRow.status,'awaiting_external_response');
  assert.equal(responseRow.mayReport,true);
  assert.equal(reportedBefore.data.externalReviewerLoginAvailable,false);
  assert.equal(reportedBefore.data.reviewerIdentityVerified,false);
  const responseBody={
    reportRow:row,expectedRef:reportedBefore.data.snapshotRef,
    expectedLatestResponseId:null,
    custodyRequestId:responseRow.custodyRequestId,
    manifestId:responseRow.manifestId,fileSha256:responseRow.fileSha256,
    firstClaimId:responseRow.firstClaimId,
    secondClaimId:responseRow.secondClaimId,
    reviewerCode:'EXT_REVIEWER_001',
    outcome:'discrepancy_reported',issueCode:'signature_missing',
    note:'Owner reports an unsigned external document; verify with another person.',
    requestId:randomUUID(),
  };
  assert.equal((await req(responseUrl,one.data.token,'POST',responseBody)).status,403);
  assert.equal((await req(responseUrl,two.data.token,'POST',responseBody)).status,403);
  assert.equal((await req(responseUrl,null,'POST',responseBody)).status,401);
  const reported=await req(responseUrl,ownerToken,'POST',responseBody);
  assert.equal(reported.status,201);
  assert.equal(reported.data.recorded,true);
  assert.equal(reported.data.reviewerIdentityVerified,false);
  assert.equal(reported.data.independentReviewConfirmed,false);
  assert.equal(reported.data.stockImportAuthorized,false);
  const reportedNext=await req(responseUrl+'?search='+encodeURIComponent(sku),ownerToken);
  const responseCase=reportedNext.data.items.find(x=>x.reportRow===row);
  assert.ok(responseCase);
  assert.equal(responseCase.status,'reported_discrepancy_open');
  assert.equal(responseCase.countDiscrepancyOpen,true);
  assert.equal(responseCase.latestResponse.issueCode,'signature_missing');
  assert.equal(responseCase.latestResponse.acknowledgedByReviewerAccount,false);
  assert.notEqual(reportedNext.data.snapshotRef,reportedBefore.data.snapshotRef);
  assert.equal((await req(responseUrl+'?expectedRef='+reportedBefore.data.snapshotRef,ownerToken)).status,409);
  const receivedReport=await req(responseUrl,ownerToken,'POST',{
    ...responseBody,expectedRef:reportedNext.data.snapshotRef,
    expectedLatestResponseId:responseCase.latestResponse.id,
    outcome:'acknowledgement_reported',issueCode:null,
    note:'Owner says a reply was received but no independent login or signature was checked.',
    requestId:randomUUID(),
  });
  assert.equal(receivedReport.status,201);
  const afterResponse=await req(responseUrl+'?search='+encodeURIComponent(sku),ownerToken);
  const acknowledged=afterResponse.data.items.find(x=>x.reportRow===row);
  assert.ok(acknowledged);
  assert.equal(acknowledged.status,'acknowledgement_unverified');
  assert.equal(acknowledged.countDiscrepancyOpen,true);
  assert.equal(afterResponse.data.reviewerIdentityVerified,false);
  assert.equal(afterResponse.data.independentReviewConfirmed,false);
  assert.equal(afterResponse.data.ownerApproved,false);
  assert.equal(afterResponse.data.checkoutAuthorized,false);
  assert.equal((await req(responseUrl+'?status=approved',ownerToken)).status,400);
  assert.equal((await req(responseUrl+'?unknown=1',ownerToken)).status,400);
  const review=await req('/stock-safety/count-claims-review?search='+encodeURIComponent(sku),ownerToken);
  assert.equal(review.status,200);
  assert.equal(review.data.items[0].firstUnits,7);
  assert.equal(review.data.items[0].secondUnits,9);
  assert.equal(review.data.items[0].stage,'discrepant_claims');
  assert.equal(review.data.ownerApproved,false);
  assert.equal(review.data.checkoutAuthorized,false);
  assert.equal(review.data.stockImportAuthorized,false);
  const triageBody={
    reportRow:row,expectedRef:review.data.snapshotRef,
    expectedFirstClaimId:review.data.items[0].firstClaimId,
    expectedSecondClaimId:review.data.items[0].secondClaimId,
    expectedLatestTriageId:null,
    decision:'request_recount',note:'Different counts. Request independent recount.',
    requestId:randomUUID(),
  };
  assert.equal((await req('/stock-safety/count-owner-triage',one.data.token,'POST',triageBody)).status,403);
  assert.equal((await req('/stock-safety/count-owner-triage',two.data.token,'POST',triageBody)).status,403);
  assert.equal((await req('/stock-safety/count-owner-triage',null,'POST',triageBody)).status,401);
  const triage=await req('/stock-safety/count-owner-triage',ownerToken,'POST',triageBody);
  assert.equal(triage.status,201);
  assert.equal(triage.data.kind,'local-unverified-count-owner-triage');
  assert.equal(triage.data.ownerApproved,false);
  assert.equal(triage.data.stockImportAuthorized,false);
  assert.equal(triage.data.checkoutAuthorized,false);
  assert.equal((await req('/stock-safety/count-owner-triage',ownerToken,'POST',triageBody)).data.replayed,true);
  assert.equal((await req('/stock-safety/count-owner-triage',ownerToken,'POST',{
    ...triageBody,requestId:randomUUID(),expectedLatestTriageId:null,
  })).status,409);
  assert.equal((await req('/stock-safety/count-owner-triage',ownerToken,'POST',{
    ...triageBody,requestId:randomUUID(),decision:'approved',
  })).status,400);
  const reviewedAgain=await req('/stock-safety/count-claims-review?search='+encodeURIComponent(sku),ownerToken);
  assert.equal(reviewedAgain.status,200);
  assert.equal(reviewedAgain.data.items[0].triage.decision,'request_recount');
  assert.equal(reviewedAgain.data.items[0].triage.needsRecheck,false);
  assert.equal((await req('/stock-safety/count-worklist?search='+encodeURIComponent(sku),one.data.token)).data.items[0].triage,undefined);
  assert.equal((await req('/stock-safety/count-claims-review?unknown=1',ownerToken)).status,400);
  assert.equal((await req('/stock-safety/count-worklist?expectedRef='+ '0'.repeat(64),one.data.token)).status,409);
  sku='CHANGED-WOO-PRODUCT';
  catalog.cache.fetchedAt='2000-01-01T00:00:00.000Z';
  assert.equal((await req('/stock-safety/count-claims-review?expectedRef='+review.data.snapshotRef,ownerToken)).status,409);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sales').get().n,0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM instore_sales').get().n,0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sale_events').get().n,0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='inventory.count_claim'").get().n,2);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='inventory.count_owner_triage'").get().n,1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='inventory.count_supervision_note'").get().n,1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='inventory.private_count_file_manifest'").get().n,1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='inventory.private_evidence_custody'").get().n,2);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='inventory.external_reviewer_response_claim'").get().n,2);
  assert.ok(log.length>=1&&log.every(entry=>entry==='Woo GET products'));
});
