import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync } from 'node:crypto';
import {
  signSyntheticIncidentTicket,signSyntheticAlertDeliveryClaim,
  assessSyntheticIncidentAlertDelivery,
} from '../server/audit-incident-delivery-contract.js';

const env={NODE_ENV:'test',MANSU_CI_SYNTHETIC_INCIDENT_DELIVERY:'true'};
const ID='f'.repeat(64);
const when='2026-11-15T17:00:00.000Z';
const after='2026-11-15T17:03:00.000Z';
function fixture(deliveryStatus='delivered'){
  const ticketKeys=generateKeyPairSync('ed25519');
  const notifierKeys=generateKeyPairSync('ed25519');
  const ticket=signSyntheticIncidentTicket({
    env,incidentId:ID,code:'EXTERNAL_WITNESS_UNAVAILABLE',
    issuedAt:when,privateKey:ticketKeys.privateKey,
  });
  const claim=signSyntheticAlertDeliveryClaim({
    env,ticket,recipientRole:'owner',deliveryStatus,
    issuedAt:after,privateKey:notifierKeys.privateKey,
  });
  const opts={env,ticket,claim,
    pinnedTicketPublicKey:ticketKeys.publicKey,
    pinnedNotifierPublicKey:notifierKeys.publicKey,
    now:'2026-11-15T17:04:00.000Z'};
  return {ticketKeys,notifierKeys,ticket,claim,opts};
}
function closed(report){
  for(const prop of ['externalTicketDurabilityVerified',
    'recipientIdentityIndependentlyVerified','realOwnerReceivedAlert',
    'independentlyVerifiedDeliveryReceipt','productionAlertServiceConnected',
    'automaticIncidentClosureAuthorized','customerPayoutAuthorized',
    'checkoutAuthorized','refundAuthorized','stockRestored']){
    assert.equal(report[prop],false,prop);
  }
}
test('separately signed synthetic ticket and "delivered" claim never proves actual Owner receipt',()=>{
  const x=fixture();
  const result=assessSyntheticIncidentAlertDelivery(x.opts);
  assert.equal(result.ticketSignatureValid,true);
  assert.equal(result.notifierSignatureValid,true);
  assert.equal(result.ticketBoundToClaim,true);
  assert.equal(result.chronological,true);
  assert.equal(result.syntheticDeliveredClaimMatches,true);
  assert.equal(result.status,'synthetic_claim_consistent_not_authentic_delivery');
  closed(result);
  assert.equal(Object.isFrozen(result),true);
  const raw=JSON.stringify(result);
  assert.equal(raw.includes(ID),false);
  assert.equal(raw.includes('private@'),false);
});
test('pending and failed alert delivery remain blocked and cannot close or bypass an incident',()=>{
  for(const status of ['pending','failed']){
    const x=fixture(status);
    const report=assessSyntheticIncidentAlertDelivery(x.opts);
    assert.equal(report.syntheticDeliveredClaimMatches,false);
    assert.equal(report.status,'blocked_missing_or_unconfirmed_notification');
    closed(report);
  }
});
test('tampered claim, forged signatures, and independently pinned wrong key fail closed',()=>{
  const x=fixture();
  for(const change of [
    {deliveryStatus:'failed'},{recipientRole:'manager'},
    {incidentId:'a'.repeat(64)},{ticketDigest:'a'.repeat(64)},
    {signature:'A'.repeat(86)},
    {customerEmail:'secret@example.invalid'},
  ]) assert.throws(()=>assessSyntheticIncidentAlertDelivery({
    ...x.opts,claim:{...x.claim,...change},
  }));
  const wrong=generateKeyPairSync('ed25519');
  assert.throws(()=>assessSyntheticIncidentAlertDelivery({
    ...x.opts,pinnedNotifierPublicKey:wrong.publicKey,
  }));
  assert.throws(()=>assessSyntheticIncidentAlertDelivery({
    ...x.opts,pinnedNotifierPublicKey:x.ticketKeys.publicKey,
  }));
});
test('cross-ticket replay and different incident identity fail closed',()=>{
  const x=fixture();
  const second=signSyntheticIncidentTicket({
    env,incidentId:'a'.repeat(64),code:'ACKNOWLEDGEMENT_UNKNOWN',
    issuedAt:when,privateKey:x.ticketKeys.privateKey,
  });
  assert.throws(()=>assessSyntheticIncidentAlertDelivery({
    ...x.opts,ticket:second,
  }));
  assert.throws(()=>assessSyntheticIncidentAlertDelivery({
    ...x.opts,ticket:{...x.ticket,code:'ACKNOWLEDGEMENT_UNKNOWN'},
  }));
});
test('future timestamp, stale evidence and reversed chronology fail report closed',()=>{
  const x=fixture();
  for(const date of ['2026-11-14T17:04:00.000Z','2026-11-25T17:04:00.000Z']){
    const result=assessSyntheticIncidentAlertDelivery({...x.opts,now:date});
    assert.equal(result.chronological,false);
    assert.equal(result.syntheticDeliveredClaimMatches,false);
    closed(result);
  }
  const earlier=signSyntheticAlertDeliveryClaim({
    env,ticket:x.ticket,recipientRole:'owner',deliveryStatus:'delivered',
    issuedAt:'2026-11-15T16:59:00.000Z',privateKey:x.notifierKeys.privateKey,
  });
  const result=assessSyntheticIncidentAlertDelivery({...x.opts,claim:earlier});
  assert.equal(result.chronological,false);
  closed(result);
});
test('strict synthetic isolation refuses production, invalid incident, recipient, status, and mismatched private key type',()=>{
  const x=fixture();
  assert.throws(()=>assessSyntheticIncidentAlertDelivery({
    ...x.opts,env:{NODE_ENV:'production',MANSU_CI_SYNTHETIC_INCIDENT_DELIVERY:'true'},
  }));
  assert.throws(()=>signSyntheticIncidentTicket({
    env,incidentId:ID,code:'PAYOUT_APPROVED',issuedAt:when,
    privateKey:x.ticketKeys.privateKey,
  }));
  assert.throws(()=>signSyntheticIncidentTicket({
    env,incidentId:'raw-customer-id',code:'EXTERNAL_ANCHOR_MISMATCH',
    issuedAt:when,privateKey:x.ticketKeys.privateKey,
  }));
  assert.throws(()=>signSyntheticAlertDeliveryClaim({
    env,ticket:x.ticket,recipientRole:'cashier',deliveryStatus:'delivered',
    issuedAt:after,privateKey:x.notifierKeys.privateKey,
  }));
  assert.throws(()=>signSyntheticAlertDeliveryClaim({
    env,ticket:x.ticket,recipientRole:'owner',deliveryStatus:'money_sent',
    issuedAt:after,privateKey:x.notifierKeys.privateKey,
  }));
  assert.throws(()=>signSyntheticIncidentTicket({
    env,incidentId:ID,code:'EXTERNAL_WITNESS_UNAVAILABLE',
    issuedAt:when,privateKey:x.ticketKeys.publicKey,
  }));
});
test('synthetic signed claims contain no live delivery transport, merchant or payment actions',()=>{
  const source=fs.readFileSync(fileURLToPath(new URL('../server/audit-incident-delivery-contract.js',import.meta.url)),'utf8');
  for(const forbidden of ['fetch(', 'http.request(', 'createApp(',
    'sendMail(', 'sendSms(', 'app.post(', 'process.env']){
    assert.equal(source.includes(forbidden),false,forbidden);
  }
  const x=fixture();
  assert.equal(x.ticket.recipientRole,undefined);
  assert.equal(x.claim.recipientRole,'owner');
  closed(assessSyntheticIncidentAlertDelivery(x.opts));
});
