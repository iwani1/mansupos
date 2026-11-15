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
  const review=await req('/stock-safety/count-claims-review?search='+encodeURIComponent(sku),ownerToken);
  assert.equal(review.status,200);
  assert.equal(review.data.items[0].firstUnits,7);
  assert.equal(review.data.items[0].secondUnits,9);
  assert.equal(review.data.items[0].stage,'discrepant_claims');
  assert.equal(review.data.ownerApproved,false);
  assert.equal(review.data.checkoutAuthorized,false);
  assert.equal(review.data.stockImportAuthorized,false);
  assert.equal((await req('/stock-safety/count-claims-review?unknown=1',ownerToken)).status,400);
  assert.equal((await req('/stock-safety/count-worklist?expectedRef='+ '0'.repeat(64),one.data.token)).status,409);
  sku='CHANGED-WOO-PRODUCT';
  catalog.cache.fetchedAt='2000-01-01T00:00:00.000Z';
  assert.equal((await req('/stock-safety/count-claims-review?expectedRef='+review.data.snapshotRef,ownerToken)).status,409);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sales').get().n,0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM instore_sales').get().n,0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sale_events').get().n,0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='inventory.count_claim'").get().n,2);
  assert.ok(log.length>=1&&log.every(entry=>entry==='Woo GET products'));
});
