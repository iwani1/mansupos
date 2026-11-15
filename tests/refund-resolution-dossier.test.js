import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { hashPassword } from '../server/db.js';
import { saleEvent } from '../server/sale-events.js';
import { refundResolutionDossier } from '../server/refund-resolution-dossier.js';

function harness(live = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mansu-resolution-'));
  const calls = [];
  const api = {
    async products() { calls.push('products'); throw Error('No Woo catalogue'); },
    async variations() { calls.push('variations'); throw Error('No Woo variants'); },
    async order() { calls.push('order'); throw Error('No Woo order reads'); },
    async createOrder() { calls.push('createOrder'); throw Error('No Woo order writes'); },
    async updateOrder() { calls.push('updateOrder'); throw Error('No Woo order writes'); },
  };
  const env = live ? {
    NODE_ENV: 'test', POS_MODE: 'live', POS_LIVE_READ_ONLY: 'true',
    POS_ALLOW_LIVE_WRITES: 'false',
    POS_PUBLIC_ORIGIN: 'https://pos.mansutrendzgh.com',
    WOO_BASE_URL: 'https://mansutrendzgh.com',
    WOO_CONSUMER_KEY: 'ck_synthetic', WOO_CONSUMER_SECRET: 'cs_synthetic',
    POS_OWNER_USERNAME: 'owner',
    POS_OWNER_PASSWORD: 'synthetic-pilot-password-123', POS_DATA_DIR: dir,
  } : { NODE_ENV: 'test', POS_MODE: 'demo', POS_DATA_DIR: dir };
  const { app, db } = createApp({ env, api, logger: {
    debug() {}, info() {}, warn() {}, error() {},
  } });
  const server = app.listen(0, '127.0.0.1');
  const ready = new Promise(resolve => server.once('listening', resolve));
  return {
    db, calls, dir, async stop() {
      await new Promise(resolve => server.close(resolve));
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
    async call(endpoint, method = 'GET', body, token) {
      await ready;
      const response = await fetch('http://127.0.0.1:' + server.address().port + '/api' + endpoint, {
        method, headers: { 'Content-Type': 'application/json',
          ...(token ? { Authorization: 'Bearer ' + token } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: response.status, body: await response.json() };
    },
  };
}
function seed(db, { status = 'partially_refunded', refunded = 5000, paid = true,
  wooId = null } = {}) {
  const id = randomUUID(), stamp = '2026-11-15T14:00:00.000Z';
  const originalWoo = wooId === null ? 78000 + db.prepare('SELECT COUNT(*) AS n FROM sales').get().n : wooId;
  db.prepare('INSERT INTO sales (id,idempotency_key,fingerprint,number,status,woo_order_id,' +
    'payment_method,total,refunded,paid_at,shift_id,updated_at,created_at,currency,' +
    'cashier_id,cashier_name,note,items_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id,randomUUID(),'synthetic','RES-' + id.slice(0,7),status,originalWoo,
      'cash',20000,refunded,paid ? stamp : null,null,stamp,stamp,'GHS','cashier','Synthetic','', '[]');
  saleEvent(db,id,'online.intent','synthetic',{wooOrderId:originalWoo || null});
  if (paid) saleEvent(db,id,'online.payment_verified','synthetic',{wooOrderId:originalWoo || null});
  return id;
}
const draftPayload = (d,intent = 'return_and_refund',amount = 5000,key = randomUUID()) => ({
  draftKey: key, intent, reasonCode: 'size_mismatch', proposedCents: amount,
  expectedStatus: d.saleStatus, expectedUpdatedAt: d.originalUpdatedAt,
  expectedWooOrderId: d.wooOrderId, expectedRefundedCents: d.recordedRefundedCents,
});

test('demo-only original refund proposal is audited once, separated from different Owner review, and never approves payout/restock', async t => {
  const h = harness(); t.after(() => h.stop());
  const mid = randomUUID();
  h.db.prepare('INSERT INTO users(id,username,name,role,password_hash,active,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(mid, 'resolution-manager', 'Synthetic manager', 'manager',
      hashPassword('synthetic-manager-password-123'),1,new Date().toISOString());
  const manager = await h.call('/auth/login','POST',{
    username:'resolution-manager',password:'synthetic-manager-password-123'});
  assert.equal(manager.status,200);
  const mt = manager.body.token;
  const owner = await h.call('/auth/demo','POST',{});
  assert.equal(owner.status,200);
  const ot = owner.body.token;
  const saleId = seed(h.db);
  const policy = refundResolutionDossier(h.db, saleId, true);
  assert.equal(policy.recordProposalAllowed, true);
  assert.equal(policy.cashPayoutAuthorized, false);
  assert.equal(policy.wooStockRestorationAuthorized, false);
  const route = '/payments/reconciliation/' + saleId + '/resolution';
  const initial = await h.call(route,'GET',undefined,mt);
  assert.equal(initial.status,200);
  assert.equal(initial.body.kind,'non-executing-refund-resolution-dossier');
  assert.equal(initial.body.actionsAvailable,true);
  assert.equal(initial.body.recordProposalAllowed,true);
  assert.equal(initial.body.ownerRefundApprovalIssued,false);
  assert.equal(initial.body.settlementVerified,false);
  assert.equal(initial.body.payoutVerified,false);
  assert.equal(initial.body.returnPhysicallyInspected,false);
  assert.equal(initial.body.wooStockRestorationAuthorized,false);
  const draft = draftPayload(initial.body);
  const originalRow=h.db.prepare('SELECT * FROM sales WHERE id=?').get(saleId);
  const n=h.db.prepare('SELECT COUNT(*) AS n FROM sale_events WHERE sale_id=?').get(saleId).n;
  assert.equal((await h.call(route)).status,401);
  const first=await h.call(route,'POST',draft,mt);
  assert.equal(first.status,201,JSON.stringify(first.body));
  assert.equal(first.body.entry.refundAuthorized,false);
  assert.equal(first.body.entry.stockRestored,false);
  const again=await h.call(route,'POST',draft,mt);
  assert.equal(again.status,200);
  assert.equal(again.body.entry.id,first.body.entry.id);
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM sale_events WHERE sale_id=?').get(saleId).n,n+1);
  const summary=await h.call(route,'GET',undefined,ot);
  assert.equal(summary.body.recordProposalAllowed,false);
  assert.equal(summary.body.historicalProposal.intent,'return_and_refund');
  assert.equal(summary.body.historicalOwnerReview,null);
  const ownerReviewRoute=route+'/owner-review';
  const ownerPayload={draftKey:draft.draftKey,draftEventId:first.body.entry.id,
    expectedStatus:initial.body.saleStatus,expectedUpdatedAt:initial.body.originalUpdatedAt,
    expectedRefundedCents:initial.body.recordedRefundedCents};
  assert.equal((await h.call(ownerReviewRoute,'POST',ownerPayload,mt)).status,403);
  const reviewed=await h.call(ownerReviewRoute,'POST',ownerPayload,ot);
  assert.equal(reviewed.status,201,JSON.stringify(reviewed.body));
  assert.equal(reviewed.body.entry.refundAuthorized,false);
  assert.equal(reviewed.body.entry.payoutVerified,false);
  assert.equal((await h.call(ownerReviewRoute,'POST',ownerPayload,ot)).status,200);
  const after=await h.call(route,'GET',undefined,mt);
  assert.equal(after.body.historicalOwnerReview.kind,'owner_review_record');
  assert.equal(after.body.ownerRefundApprovalIssued,false);
  assert.equal(after.body.goodsReleaseAuthorized,false);
  assert.equal(after.body.stockRestored,false);
  assert.equal(after.body.decision,'external_evidence_and_authorization_required');
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM sale_events WHERE sale_id=?').get(saleId).n,n+2);
  assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action IN ('finance.resolution.draft','finance.resolution.owner_reviewed')").get().n,2);
  assert.deepEqual(h.db.prepare('SELECT * FROM sales WHERE id=?').get(saleId),originalRow);
  assert.deepEqual(h.calls,[]);
});

test('demo-only resolution rejects exceeding balance, stale cumulative refund, self review, reused keys and unexpected customer data', async t => {
  const h=harness(); t.after(() => h.stop());
  const owner=(await h.call('/auth/demo','POST',{})).body.token;
  const id=seed(h.db),route='/payments/reconciliation/'+id+'/resolution';
  const d=(await h.call(route,'GET',undefined,owner)).body;
  const baseline=h.db.prepare('SELECT COUNT(*) AS n FROM sale_events').get().n;
  const tooMuch=draftPayload(d,'refund_only',15001);
  assert.equal((await h.call(route,'POST',tooMuch,owner)).status,409);
  const noAmount=draftPayload(d,'refund_only',0);
  assert.equal((await h.call(route,'POST',noAmount,owner)).status,400);
  const exchangeWithPayout=draftPayload(d,'exchange_request',5000);
  assert.equal((await h.call(route,'POST',exchangeWithPayout,owner)).status,400);
  const extra=draftPayload(d);
  assert.equal((await h.call(route,'POST',{...extra,cardNumber:'1234'},owner)).status,400);
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM sale_events').get().n,baseline);
  const allowed=draftPayload(d,'exchange_request',0);
  const first=await h.call(route,'POST',allowed,owner);
  assert.equal(first.status,201,JSON.stringify(first.body));
  assert.equal((await h.call(route,'POST',{...allowed,intent:'no_refund_review'},owner)).status,409);
  const unrelated=seed(h.db);
  assert.equal((await h.call('/payments/reconciliation/'+unrelated+'/resolution','POST',allowed,owner)).status,409);
  const another=draftPayload(d,'refund_only',5000);
  assert.equal((await h.call(route,'POST',another,owner)).status,409);
  const ack={draftKey:allowed.draftKey,draftEventId:first.body.entry.id,
    expectedStatus:d.saleStatus,expectedUpdatedAt:d.originalUpdatedAt,
    expectedRefundedCents:d.recordedRefundedCents};
  assert.equal((await h.call(route+'/owner-review','POST',ack,owner)).status,409);
  h.db.prepare('UPDATE sales SET refunded=? WHERE id=?').run(6000,id);
  const dossier=await h.call(route,'GET',undefined,owner);
  assert.equal(dossier.body.recordedRefundedCents,6000);
  assert.equal((await h.call(route+'/owner-review','POST',ack,owner)).status,409);
  assert.deepEqual(h.calls,[]);
});

test('full prior refund and inconsistent order cannot create a new payout proposal; independent evidence always absent', async t => {
  const h=harness(); t.after(() => h.stop());
  const owner=(await h.call('/auth/demo','POST',{})).body.token;
  const fullId=seed(h.db,{status:'refunded',refunded:20000});
  const fullUrl='/payments/reconciliation/'+fullId+'/resolution';
  const full=(await h.call(fullUrl,'GET',undefined,owner)).body;
  assert.equal((await h.call(fullUrl,'POST',draftPayload(full,'refund_only',1),owner)).status,409);
  assert.equal(full.ownerRefundApprovalIssued,false);
  assert.ok(full.requiredChecks.some(x=>x.code==='actual_customer_payout_evidence' && x.observed===false));
  assert.ok(full.requiredChecks.some(x=>x.code==='physically_received_and_inspected_return' && x.observed===false));
  const badId=seed(h.db,{status:'paid',refunded:5000});
  const badUrl='/payments/reconciliation/'+badId+'/resolution';
  const bad=(await h.call(badUrl,'GET',undefined,owner)).body;
  assert.ok(bad.conflictingLocalEvidence.includes('woo_refund_state_inconsistent'));
  assert.equal((await h.call(badUrl,'POST',draftPayload(bad,'exchange_request',0),owner)).status,409);
});

test('live read-only POS denies all resolution proposal and review POSTs while authenticated Owner/Manager may inspect',async t=>{
  const h=harness(true);t.after(()=>h.stop());
  const id=seed(h.db);
  const before=h.db.prepare('SELECT * FROM sales WHERE id=?').get(id);
  const beforeEvents=h.db.prepare('SELECT * FROM sale_events').all();
  const url='/payments/reconciliation/'+id+'/resolution';
  assert.equal((await h.call(url)).status,401);
  const login=await h.call('/auth/login','POST',{username:'owner',password:'synthetic-pilot-password-123'});
  assert.equal(login.status,200);
  const token=login.body.token;
  assert.equal((await h.call('/auth/password','POST',{
    currentPassword:'synthetic-pilot-password-123',
    newPassword:'synthetic-rotated-password-123',
  },token)).status,200);
  const dossier=await h.call(url,'GET',undefined,token);
  assert.equal(dossier.status,200);
  assert.equal(dossier.body.actionsAvailable,false);
  assert.equal(dossier.body.recordProposalAllowed,false);
  assert.equal(dossier.body.refundExecuted,false);
  const payload=draftPayload(dossier.body);
  assert.equal((await h.call(url,'POST',payload,token)).status,403);
  assert.equal((await h.call(url+'/owner-review','POST',{
    draftKey:payload.draftKey,draftEventId:1,
    expectedStatus:dossier.body.saleStatus, expectedUpdatedAt:dossier.body.originalUpdatedAt,
    expectedRefundedCents:dossier.body.recordedRefundedCents,
  },token)).status,403);
  assert.equal((await h.call(url,'POST',{...payload,externalPaymentSecret:'secret'},token)).status,403);
  const person=h.db.prepare("SELECT id FROM users WHERE username='owner'").get();
  h.db.prepare("UPDATE users SET role='manager' WHERE id=?").run(person.id);
  assert.equal((await h.call(url,'GET',undefined,token)).status,200);
  assert.equal((await h.call(url,'POST',payload,token)).status,403);
  h.db.prepare("UPDATE users SET role='cashier' WHERE id=?").run(person.id);
  assert.equal((await h.call(url,'GET',undefined,token)).status,403);
  assert.deepEqual(h.db.prepare('SELECT * FROM sales WHERE id=?').get(id),before);
  assert.deepEqual(h.db.prepare('SELECT * FROM sale_events').all(),beforeEvents);
  assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action LIKE 'finance.resolution.%'").get().n,0);
  assert.deepEqual(h.calls,[]);
});
