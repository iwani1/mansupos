import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createApp} from '../server/app.js';
import {loadInStoreSnapshot} from '../server/instore-catalog.js';

test('owner mapping API reads Woo products only, stores local notes and never approves stock',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mansu-owner-mapping-'));
  const physical=loadInStoreSnapshot();
  const first=physical.items.find(item=>item.status==='available'&&item.sku);
  assert.ok(first,'Signed physical source must contain an eligible SKU');
  let sku=first.sku;
  const calls=[];
  const api={
    async products(){
      calls.push('GET products');
      return {data:[{
        id:876,name:'Synthetic',type:'simple',sku,status:'publish',
        price:'110.00',stock_status:'instock',manage_stock:true,
        stock_quantity:7,purchasable:true,backorders:'no',
        images:[],categories:[],
      }],pages:1,total:1};
    },
    async variations(){throw Error('Unexpected variation request');},
    async order(){throw Error('Woo order read forbidden');},
    async createOrder(){throw Error('Woo order write forbidden');},
    async updateOrder(){throw Error('Woo stock write forbidden');},
  };
  const env={
    NODE_ENV:'test',POS_MODE:'live',POS_LIVE_READ_ONLY:'true',
    POS_ALLOW_LIVE_WRITES:'false',WOO_BASE_URL:'https://mansutrendzgh.com',
    WOO_CONSUMER_KEY:'ck_synthetic',WOO_CONSUMER_SECRET:'cs_synthetic',
    POS_PUBLIC_ORIGIN:'https://pos.mansutrendzgh.com',
    POS_DATA_DIR:dir,POS_OWNER_USERNAME:'owner',
    POS_OWNER_PASSWORD:'synthetic-pilot-password-123',
  };
  const {app,db,catalog}=createApp({env,api,logger:{
    debug(){},info(){},warn(){},error(){},
  }});
  const server=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  t.after(async()=>{
    await new Promise(resolve=>server.close(resolve));
    db.close();
    fs.rmSync(dir,{recursive:true,force:true});
  });
  const base='http://127.0.0.1:'+server.address().port+'/api';
  const req=async(route,token=null,method='GET',body)=>{
    const r=await fetch(base+route,{method,
      headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},
      ...(body?{body:JSON.stringify(body)}:{})});
    return {status:r.status,data:await r.json(),cache:r.headers.get('cache-control')};
  };
  const url='/stock-safety/owner-mapping-evidence';
  assert.equal((await req(url)).status,401);
  const login=await req('/auth/login',null,'POST',{
    username:'owner',password:'synthetic-pilot-password-123',
  });
  assert.equal(login.status,200);
  const token=login.data.token;
  assert.equal((await req('/auth/password',token,'POST',{
    currentPassword:'synthetic-pilot-password-123',
    newPassword:'synthetic-rotated-password-123',
  })).status,200);
  const start=await req(url+'?search='+encodeURIComponent(sku),token);
  assert.equal(start.status,200);
  assert.equal(start.data.kind,'local-owner-mapping-evidence-review');
  assert.equal(start.data.evidenceVerified,true);
  assert.equal(start.cache,'no-store');
  const candidate=start.data.items.find(item=>item.sku===sku.trim().toUpperCase());
  assert.ok(candidate);
  assert.equal(candidate.classification,'provisional_match');
  const proposal={
    reportRow:candidate.reportRow,expectedRef:start.data.identityRef,
    expectedLatestReviewId:null,decision:'propose_option',
    proposedProductId:876,proposedVariationId:null,
    note:'Physically check the SKU, correct size and colour.',
    requestId:randomUUID(),
  };
  const created=await req(url,token,'POST',proposal);
  assert.equal(created.status,201);
  assert.equal(created.data.recorded,true);
  assert.equal(created.data.stockImportAuthorized,false);
  assert.equal(created.data.checkoutAuthorized,false);
  assert.equal(created.data.mappingApproved,false);
  assert.equal((await req(url,token,'POST',proposal)).data.replayed,true);
  const newReview=await req(url+'?search='+encodeURIComponent(sku),token);
  assert.equal(newReview.data.items[0].latestReview.proposedProductId,876);
  assert.equal(newReview.data.items[0].latestReview.mappingApproved,false);
  const old=await req(url+'?expectedRef='+ '0'.repeat(64),token);
  assert.equal(old.status,409);
  assert.equal((await req(url,token,'POST',{
    ...proposal,requestId:randomUUID(),expectedLatestReviewId:null,
  })).status,409);
  assert.equal((await req(url,token,'POST',{
    ...proposal,requestId:randomUUID(),decision:'stock_import',
  })).status,400);
  assert.equal((await req(url+'?unexpected=1',token)).status,400);
  const actor=db.prepare("SELECT id FROM users WHERE username='owner'").get();
  db.prepare("UPDATE users SET role='manager' WHERE id=?").run(actor.id);
  assert.equal((await req(url,token)).status,403);
  assert.equal((await req(url,token,'POST',proposal)).status,403);
  db.prepare("UPDATE users SET role='cashier' WHERE id=?").run(actor.id);
  assert.equal((await req(url,token)).status,403);
  db.prepare("UPDATE users SET role='owner' WHERE id=?").run(actor.id);
  sku='CHANGED-SKU';
  catalog.cache.fetchedAt='2000-01-01T00:00:00.000Z';
  assert.equal((await req(url+'?expectedRef='+start.data.identityRef,token)).status,409);
  assert.equal((await req(url,token,'POST',{
    ...proposal,requestId:randomUUID(),
  })).status,409);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sales').get().n,0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM instore_sales').get().n,0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sale_events').get().n,0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='inventory.owner_mapping_review'").get().n,1);
  assert.ok(calls.length>=1&&calls.every(call=>call==='GET products'));
});
