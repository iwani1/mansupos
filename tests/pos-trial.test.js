import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { openDesktopDatabase, DesktopStore } from '../desktop/store.js';
import { TrialController } from '../desktop/pos-trial/controller.js';
import { TrialRemote, TRIAL_ORIGIN, TRIAL_USERNAME, TRIAL_PASSWORD } from '../desktop/pos-trial/trial-remote.js';
import { trialSlip } from '../desktop/pos-trial/receipt.js';

function fixture(t) {
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'mansu-practice-'));
  const dir=path.join(base,'Mansu POS Practice - NOT FOR SALES');
  const real=path.join(base,'MansutRENDZGH POS');
  fs.mkdirSync(real);
  fs.writeFileSync(path.join(real,'desktop-ledger.sqlite'),'UNCHANGED REAL POS DATA');
  const key=randomBytes(32);
  const codec={
    encryptString(value){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);
      return Buffer.concat([iv,cipher.update(value,'utf8'),cipher.final(),cipher.getAuthTag()]);},
    decryptString(blob){const iv=blob.subarray(0,12),cipher=createDecipheriv('aes-256-gcm',key,iv);
      cipher.setAuthTag(blob.subarray(-16));return Buffer.concat([cipher.update(blob.subarray(12,-16)),cipher.final()]).toString('utf8');},
  };
  const f={base,dir,real,codec,store:null,remote:null,controller:null,
    open(){this.remote=new TrialRemote();this.store=new DesktopStore(openDesktopDatabase(dir),codec,this.remote,{practiceMode:true});
      this.remote.store=this.store;this.controller=new TrialController(this.store,this.remote);},
    restart(){this.store.close();this.open();},
    close(){try{this.store?.close();}finally{fs.rmSync(base,{recursive:true,force:true});}},
  };
  f.open();t.after(()=>f.close());return f;
}
const sample=(key=randomUUID(),items=[{productId:991001,variationId:0,quantity:1}])=>({idempotencyKey:key,items,note:'SIMULATED PRACTICE'});
const pay=(id,tendered=2500)=>({path:`/api/sales/${id}/pay`,method:'POST',body:{method:'cash',tendered,confirmed:true,practiceConfirmed:true}});

test('standalone fake identity has no trading host, real credentials, live operations or payment method',async t=>{
  const f=fixture(t);
  assert.equal(f.controller.session().user,null);
  assert.equal(f.controller.session().config.writesEnabled,false);
  assert.notEqual(TRIAL_ORIGIN,'https://trading.mansutrendzgh.com');
  await assert.rejects(()=>f.remote.request('https://trading.mansutrendzgh.com','','/auth/login','POST',
    {username:TRIAL_USERNAME,password:TRIAL_PASSWORD}),{code:'TRIAL_ONLY'});
  await assert.rejects(()=>f.remote.request(TRIAL_ORIGIN,'','/auth/login','POST',
    {username:'owner',password:'Actual credentials must never be entered'}),{code:'TRIAL_ONLY'});
  await f.controller.start();
  const session=f.controller.session();
  assert.equal(session.config.practiceMode,true);
  assert.equal(session.config.writesEnabled,true);
  assert.equal(session.origin,undefined);
  assert.equal(session.config.storeUrl,undefined);
  assert.equal(session.trial.simulatedConnection,false);
  const products=f.store.catalog().products;
  assert.deepEqual(products.map(p=>p.id),[991001,991002]);
  assert.equal(products[1].variations[0].stock,2);
  for(const route of ['/api/desktop/allocate','/api/desktop/connect','/api/desktop/refresh','/api/returns','/api/customers','/api/auth/login']){
    await assert.rejects(()=>f.controller.dispatch({path:route,method:'POST',body:{}}),{code:'TRIAL_ONLY'});
  }
  await assert.rejects(()=>f.controller.dispatch({path:'/api/sales/prepare',method:'POST',body:{...sample(),saleType:'wholesale'}}),{code:'TRIAL_ONLY'});
  const draft=f.store.prepare(sample());
  await assert.rejects(()=>f.controller.dispatch({...pay(draft.id),body:{method:'momo',confirmed:true,practiceConfirmed:true,reference:'fake'}}),{code:'OFFLINE_CASH_ONLY'});
  await assert.rejects(()=>f.controller.dispatch({...pay(draft.id),body:{method:'cash',tendered:2500,confirmed:true}}),{code:'TRIAL_ONLY'});
  assert.equal(f.store.sales().sales.length,0);
  assert.equal(fs.readFileSync(path.join(f.real,'desktop-ledger.sqlite'),'utf8'),'UNCHANGED REAL POS DATA');
});

test('offline sample commit survives restart, retry preserves ID, fake acknowledgement creates no order',async t=>{
  const f=fixture(t);await f.controller.start();
  const id=randomUUID();const {sale:draft}=await f.controller.dispatch({path:'/api/sales/prepare',method:'POST',body:sample(id)});
  const {sale}=await f.controller.dispatch(pay(draft.id,3000));
  assert.equal(sale.number.startsWith('PRACTICE-'),true);
  assert.equal(sale.changeDue,500);
  assert.equal(f.store.catalog().products[0].stock,1);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM movements').get().n,1);
  assert.equal(f.store.queueStatus().pending,1);
  assert.equal(f.store.sales().sales[0].syncState,'pending');
  const fingerprint=f.store.db.prepare('SELECT fingerprint FROM queue WHERE id=?').get(id).fingerprint;
  const backing=await f.controller.dispatch({path:'/api/trial/backup',method:'POST'});
  assert.equal(backing.verified,true);
  assert.equal(path.dirname(backing.path),path.join(f.dir,'backups'));
  assert.match(path.basename(backing.path),/^mansu-practice-/);
  assert.equal(f.store.pay(draft.id,{method:'cash',tendered:3000,confirmed:true}).id,id);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM queue').get().n,1);
  await f.controller.dispatch({path:'/api/trial/sync',method:'POST'});
  assert.equal(f.store.queueStatus().rows[0].state,'retry');
  assert.equal(f.store.queueStatus().rows[0].attempts,1);
  f.restart();
  assert.equal(f.controller.session().user,null);
  await f.controller.start();
  assert.equal(f.controller.session().trial.simulatedConnection,false,'relaunch resets the fake connection to offline');
  assert.equal(f.store.sale(id).number,sale.number);
  assert.equal(f.store.catalog().products[0].stock,1);
  assert.equal(f.store.queueStatus().rows[0].id,id);
  assert.equal(f.store.db.prepare('SELECT fingerprint FROM queue WHERE id=?').get(id).fingerprint,fingerprint);
  await f.controller.dispatch({path:'/api/trial/connectivity',method:'POST',body:{connected:true}});
  await f.controller.dispatch({path:'/api/trial/sync',method:'POST'});
  assert.equal(f.store.queueStatus().pending,0);
  assert.equal(f.store.queueStatus().rows[0].state,'acked');
  assert.equal(f.store.queueStatus().rows[0].attempts,2);
  assert.equal(f.store.sale(id).wooOrderId,null);
  assert.equal(f.store.sale(id).syncState,'acked');
  await f.controller.dispatch({path:'/api/trial/sync',method:'POST'});
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM queue').get().n,1);
  await f.controller.dispatch({path:'/api/trial/refresh',method:'POST'});
  assert.equal(f.store.catalog().products[0].stock,1,'sample refresh never refills a used unit');
  assert.equal(fs.readFileSync(path.join(f.real,'desktop-ledger.sqlite'),'utf8'),'UNCHANGED REAL POS DATA');
});

test('one shared sample option pool prevents overselling and print slip cannot be a receipt',async t=>{
  const f=fixture(t);await f.controller.start();
  const items=[{productId:991002,variationId:991003,quantity:2},{productId:991002,variationId:991004,quantity:1}];
  assert.throws(()=>f.store.prepare(sample(randomUUID(),items)),{code:'ALLOCATED_STOCK_CHANGED'});
  const draft=f.store.prepare(sample(randomUUID(),items.map(item=>({...item,quantity:1}))));
  const {sale}=await f.controller.dispatch(pay(draft.id,7000));
  assert.equal(sale.total,7000);
  assert.equal(f.store.db.prepare("SELECT remaining FROM allocations WHERE stock_key='991002:0'").get().remaining,0);
  const html=trialSlip(sale);
  assert.equal((html.match(/NOT A RECEIPT/g)||[]).length>=3,true);
  assert.match(html,/NO PAYMENT ACCEPTED/);
  assert.match(html,/NO GOODS RELEASED/);
  assert.match(html,/SIMULATED TOTAL/);
  assert.match(html,/Large/);
  assert.doesNotMatch(html,/Woo order|Thank you for shopping|Cash received/i);
  assert.throws(()=>trialSlip({...sale,number:'MTD-REAL'}),/recorded sample/);
  assert.throws(()=>trialSlip({...sale,items:[{...sale.items[0],productId:100}]}),/recorded sample/);
  const escaped=trialSlip({...sale,items:[{...sale.items[0],name:'<img src=x onerror=alert(1)>'}]});
  assert.match(escaped,/&lt;img/);
  assert.doesNotMatch(escaped,/<img/);
  const raw=fs.readFileSync(path.join(f.dir,'desktop-ledger.sqlite'));
  assert.equal(raw.includes(Buffer.from('SAMPLE tee')),false,'sample customer-facing sale payload is protected at rest');
});
