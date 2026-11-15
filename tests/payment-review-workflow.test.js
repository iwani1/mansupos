import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { hashPassword } from '../server/db.js';
import { saleEvent } from '../server/sale-events.js';

function fixture(live = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mansu-review-'));
  const calls = [];
  const api = {
    async products() { calls.push('products'); throw new Error('Unexpected Woo request'); },
    async variations() { calls.push('variations'); throw new Error('Unexpected Woo request'); },
    async order() { calls.push('order'); throw new Error('Unexpected Woo order request'); },
    async createOrder() { calls.push('create'); throw new Error('Unexpected Woo write'); },
    async updateOrder() { calls.push('update'); throw new Error('Unexpected Woo write'); },
  };
  const env = live ? {
    NODE_ENV:'test', POS_MODE:'live', POS_LIVE_READ_ONLY:'true',
    POS_ALLOW_LIVE_WRITES:'false', WOO_BASE_URL:'https://mansutrendzgh.com',
    WOO_CONSUMER_KEY:'ck_synthetic', WOO_CONSUMER_SECRET:'cs_synthetic',
    POS_PUBLIC_ORIGIN:'https://pos.mansutrendzgh.com', POS_OWNER_USERNAME:'owner',
    POS_OWNER_PASSWORD:'synthetic-pilot-password-123', POS_DATA_DIR:dir,
  } : { NODE_ENV:'test', POS_MODE:'demo', POS_DATA_DIR:dir };
  const { app, db } = createApp({ env, api,
    logger:{ debug(){}, info(){}, warn(){}, error(){} } });
  const server = app.listen(0,'127.0.0.1');
  const ready = new Promise(resolve => server.once('listening',resolve));
  return { db, dir, calls, async stop() {
    await new Promise(resolve => server.close(resolve));
    db.close(); fs.rmSync(dir,{recursive:true,force:true});
  }, async request(route, method='GET', body, token) {
    await ready;
    const response=await fetch('http://127.0.0.1:'+server.address().port+'/api'+route,{
      method, headers:{'Content-Type':'application/json',
        ...(token?{Authorization:'Bearer '+token}:{})},
      ...(body?{body:JSON.stringify(body)}:{}),
    });
    return {status:response.status,body:await response.json()};
  } };
}
function createSale(db,{refund=0,status='needs_reconciliation'}={}) {
  const id=randomUUID(), timestamp='2026-11-15T13:30:00.000Z';
  // Each original order must have a distinct Woo ID under the real v9
  // ledger uniqueness invariant; duplicate source IDs are a fixture fault.
  const wooId=45678+db.prepare('SELECT COUNT(*) AS n FROM sales').get().n;
  db.prepare('INSERT INTO sales(id,idempotency_key,fingerprint,number,status,woo_order_id,'+
    'payment_method,total,refunded,paid_at,shift_id,updated_at,created_at,currency,'+
    'cashier_id,cashier_name,note,items_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id,randomUUID(),'synthetic','SYN-'+id.slice(0,8),status,wooId,'cash',
      16000,refund,null,null,timestamp,timestamp,'GHS','cashier','Synthetic','', '[]');
  saleEvent(db,id,'online.intent','system',{wooOrderId:wooId});
  return id;
}
const requestInput=(item,step,key=randomUUID())=>({
  reviewKey:key,step,expectedStatus:item.saleStatus,
  expectedUpdatedAt:item.saleUpdatedAt,expectedWooOrderId:item.wooOrderId,
});

test('Demo review: Manager requests payout evidence and separate Owner acknowledges without money/stock changes',async t=>{
  const h=fixture();t.after(()=>h.stop());
  const managerId=randomUUID();
  h.db.prepare('INSERT INTO users(id,username,name,role,password_hash,active,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(managerId,'review-manager','Synthetic Manager','manager',
      hashPassword('synthetic-manager-password-123'),1,new Date().toISOString());
  const saleId=createSale(h.db,{refund:3500,status:'partially_refunded'});
  const managerLogin=await h.request('/auth/login','POST',{
    username:'review-manager',password:'synthetic-manager-password-123'});
  assert.equal(managerLogin.status,200);
  const mt=managerLogin.body.token;
  const ownLogin=await h.request('/auth/demo','POST',{});
  assert.equal(ownLogin.status,200);
  const ot=ownLogin.body.token;
  const url='/payments/reconciliation/'+saleId+'/review';
  assert.equal((await h.request(url)).status,401);
  const original=await h.request(url,'GET',undefined,mt);
  assert.equal(original.status,200);
  assert.equal(original.body.actionsAvailable,true);
  assert.equal(original.body.refundAuthorized,false);
  assert.equal(original.body.gatewaySettlementVerified,false);
  assert.ok(original.body.availableSteps.includes('request_refund_payout_evidence'));
  const input=requestInput(original.body,'request_refund_payout_evidence');
  const saleBefore=h.db.prepare('SELECT * FROM sales WHERE id=?').get(saleId);
  const start=h.db.prepare('SELECT COUNT(*) AS n FROM sale_events WHERE sale_id=?').get(saleId).n;
  const first=await h.request(url,'POST',input,mt);
  assert.equal(first.status,201,JSON.stringify(first.body));
  assert.equal(first.body.entry.refundExecuted,false);
  assert.equal(first.body.entry.stockRestored,false);
  assert.equal((await h.request(url,'POST',input,mt)).status,200);
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM sale_events WHERE sale_id=?').get(saleId).n,start+1);
  const ack={reviewKey:input.reviewKey,requestEventId:first.body.entry.eventId,
    expectedStatus:original.body.saleStatus,expectedUpdatedAt:original.body.saleUpdatedAt};
  assert.equal((await h.request('/payments/reconciliation/'+saleId+'/acknowledge','POST',ack,mt)).status,403);
  const owner=await h.request('/payments/reconciliation/'+saleId+'/acknowledge','POST',ack,ot);
  assert.equal(owner.status,201,JSON.stringify(owner.body));
  assert.equal(owner.body.entry.refundAuthorized,false);
  assert.equal(owner.body.entry.cashPaidOut,false);
  assert.equal((await h.request('/payments/reconciliation/'+saleId+'/acknowledge','POST',ack,ot)).status,200);
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM sale_events WHERE sale_id=?').get(saleId).n,start+2);
  assert.deepEqual(h.db.prepare('SELECT * FROM sales WHERE id=?').get(saleId),saleBefore);
  assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action IN ('finance.review.requested','finance.review.acknowledged')").get().n,2);
  assert.deepEqual(h.calls,[]);
});

test('Demo review: original order staleness, reused request key, self-ack, unapproved notes and missing refund rejected',async t=>{
  const h=fixture();t.after(()=>h.stop());
  const owner=(await h.request('/auth/demo','POST',{})).body.token;
  const id=createSale(h.db),url='/payments/reconciliation/'+id+'/review';
  const before=(await h.request(url,'GET',undefined,owner)).body;
  assert.equal((await h.request(url,'POST',requestInput(before,'request_refund_payout_evidence'),owner)).status,409);
  const input=requestInput(before,'verify_original_woo_order');
  assert.equal((await h.request(url,'POST',{...input,note:'private card number'},owner)).status,400);
  const requested=await h.request(url,'POST',input,owner);
  assert.equal(requested.status,201,JSON.stringify(requested.body));
  assert.equal((await h.request(url,'POST',{...input,step:'reconcile_pos_cash_custody'},owner)).status,409);
  const ack={reviewKey:input.reviewKey,requestEventId:requested.body.entry.eventId,
    expectedStatus:before.saleStatus,expectedUpdatedAt:before.saleUpdatedAt};
  assert.equal((await h.request('/payments/reconciliation/'+id+'/acknowledge','POST',ack,owner)).status,409);
  const other=createSale(h.db);
  assert.equal((await h.request('/payments/reconciliation/'+other+'/review','POST',input,owner)).status,409);
  const stale=requestInput(before,'verify_original_woo_order');
  h.db.prepare('UPDATE sales SET updated_at=? WHERE id=?').run('2026-11-15T13:31:00.000Z',id);
  assert.equal((await h.request(url,'POST',stale,owner)).status,409);
  assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM sale_events WHERE event='finance.review.requested'").get().n,1);
});

test('Live read-only pilot denies financial review POST even to Owner; original history GET is safe',async t=>{
  const h=fixture(true);t.after(()=>h.stop());
  const id=createSale(h.db);
  const login=await h.request('/auth/login','POST',{username:'owner',password:'synthetic-pilot-password-123'});
  assert.equal(login.status,200);
  const token=login.body.token;
  assert.equal((await h.request('/auth/password','POST',{
    currentPassword:'synthetic-pilot-password-123',
    newPassword:'synthetic-rotated-password-123',
  },token)).status,200);
  const url='/payments/reconciliation/'+id+'/review';
  const current=await h.request(url,'GET',undefined,token);
  assert.equal(current.status,200);
  assert.equal(current.body.actionsAvailable,false);
  const saleBefore=h.db.prepare('SELECT * FROM sales WHERE id=?').get(id);
  const n=h.db.prepare('SELECT COUNT(*) AS n FROM sale_events WHERE sale_id=?').get(id).n;
  const req=requestInput(current.body,'verify_original_woo_order');
  assert.equal((await h.request(url,'POST',req,token)).status,403);
  assert.equal((await h.request('/payments/reconciliation/'+id+'/acknowledge','POST',{
    reviewKey:req.reviewKey,requestEventId:1,expectedStatus:current.body.saleStatus,
    expectedUpdatedAt:current.body.saleUpdatedAt,
  },token)).status,403);
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM sale_events WHERE sale_id=?').get(id).n,n);
  assert.deepEqual(h.db.prepare('SELECT * FROM sales WHERE id=?').get(id),saleBefore);
  assert.deepEqual(h.calls,[]);
});
