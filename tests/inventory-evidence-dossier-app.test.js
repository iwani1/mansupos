import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createApp} from '../server/app.js';
import {loadInStoreSnapshot} from '../server/instore-catalog.js';

test('owner dossier endpoint is read-only, role-bound, source-consistent and never authorizes checkout',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mansu-dossier-'));
  const physical=loadInStoreSnapshot();
  const first=physical.items.find(x=>x.status==='available'&&x.sku);
  assert.ok(first);
  let sku=first.sku;
  const calls=[];
  const api={
    async products(){
      calls.push('GET products');
      return {data:[{
        id:716,type:'simple',sku,name:'Synthetic',status:'publish',
        price:'100.00',stock_status:'instock',manage_stock:true,stock_quantity:3,
        purchasable:true,backorders:'no',images:[],categories:[],
      }],pages:1,total:1};
    },
    async variations(){throw Error('No Woo variation request expected');},
    async order(){throw Error('Woo order reads prohibited');},
    async createOrder(){throw Error('Woo order writes prohibited');},
    async updateOrder(){throw Error('Woo stock writes prohibited');},
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
  const req=async(url,token=null,method='GET',body)=>{
    const r=await fetch(base+url,{method,headers:{
      'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})
    },...(body?{body:JSON.stringify(body)}:{})});
    return {status:r.status,data:await r.json(),cache:r.headers.get('cache-control')};
  };
  const url='/stock-safety/inventory-dossier';
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
  const firstPage=await req(url+'?page=1&pageSize=25',token);
  assert.equal(firstPage.status,200);
  assert.equal(firstPage.data.kind,'read-only-inventory-evidence-dossier');
  assert.equal(firstPage.data.totalPhysical,physical.items.length);
  assert.equal(firstPage.data.items.length,25);
  assert.equal(firstPage.data.checkoutAuthorized,false);
  assert.equal(firstPage.data.mappingApproved,false);
  assert.equal(firstPage.data.ownerApproved,false);
  assert.equal(firstPage.data.stockImportAuthorized,false);
  assert.equal(firstPage.cache,'no-store');
  const acceptanceUrl='/stock-safety/acceptance-preparation';
  assert.equal((await req(acceptanceUrl)).status,401);
  const acceptance=await req(acceptanceUrl+'?page=1&pageSize=25',token);
  assert.equal(acceptance.status,200);
  assert.equal(acceptance.data.kind,'read-only-inventory-acceptance-preparation');
  assert.equal(acceptance.data.observations.totalHistoricalRows,physical.items.length);
  assert.equal(acceptance.data.items.length,25);
  assert.equal(acceptance.data.historicalSourceVerified,true);
  assert.equal(acceptance.data.acceptanceCertificateIssued,false);
  assert.equal(acceptance.data.ownerApproved,false);
  assert.equal(acceptance.data.independentWitnessVerified,false);
  assert.equal(acceptance.data.mappingApproved,false);
  assert.equal(acceptance.data.stockImportAuthorized,false);
  assert.equal(acceptance.data.checkoutAuthorized,false);
  assert.equal(acceptance.cache,'no-store');
  assert.equal((await req(acceptanceUrl+'?page=2&expectedRef='+acceptance.data.preparationRef,token)).status,200);
  assert.equal((await req(acceptanceUrl+'?gate=approved',token)).status,400);
  assert.equal((await req(acceptanceUrl+'?pageSize=1000',token)).status,400);
  assert.equal((await req(acceptanceUrl+'?unknown=1',token)).status,400);
  assert.equal((await req(acceptanceUrl,token,'POST',{approve:true})).status,404);

  const page2=await req(url+'?page=2&pageSize=25&expectedRef='+firstPage.data.dossierRef,token);
  assert.equal(page2.status,200);
  assert.equal(page2.data.dossierRef,firstPage.data.dossierRef);
  assert.equal((await req(url+'?focus=approved',token)).status,400);
  assert.equal((await req(url+'?pageSize=1000',token)).status,400);
  assert.equal((await req(url+'?unexpected=anything',token)).status,400);
  assert.equal((await req(url,token,'POST',{approve:true})).status,404);
  const mapping=await req('/stock-safety/owner-mapping-evidence?search='+encodeURIComponent(sku),token);
  assert.equal(mapping.status,200);
  const row=mapping.data.items.find(x=>x.sku===sku.trim().toUpperCase());
  assert.ok(row);
  const post=await req('/stock-safety/owner-mapping-evidence',token,'POST',{
    reportRow:row.reportRow,
    expectedRef:mapping.data.identityRef,expectedLatestReviewId:null,
    decision:'propose_option',proposedProductId:716,proposedVariationId:null,
    note:'Verify this garment style and size independently.',
    requestId:randomUUID(),
  });
  assert.equal(post.status,201);
  const next=await req(url+'?search='+encodeURIComponent(sku),token);
  assert.equal(next.status,200);
  assert.equal(next.data.items[0].ownerMappingDecision,'propose_option');
  assert.equal(next.data.items[0].proposedWooProductId,716);
  assert.equal(next.data.items[0].stockImportAuthorized,false);
  assert.notEqual(next.data.dossierRef,firstPage.data.dossierRef);
  const acceptanceChanged=await req(acceptanceUrl,token);
  assert.equal(acceptanceChanged.status,200);
  assert.notEqual(acceptanceChanged.data.preparationRef,acceptance.data.preparationRef);
  assert.equal(acceptanceChanged.data.observations.provisionalOwnerProposals,1);
  assert.equal(acceptanceChanged.data.stockImportAuthorized,false);
  assert.equal((await req(acceptanceUrl+'?expectedRef='+acceptance.data.preparationRef,token)).status,409);

  assert.equal((await req(url+'?expectedRef='+firstPage.data.dossierRef,token)).status,409);
  const actor=db.prepare("SELECT id FROM users WHERE username='owner'").get();
  db.prepare("UPDATE users SET role='manager' WHERE id=?").run(actor.id);
  assert.equal((await req(url,token)).status,403);
  assert.equal((await req(acceptanceUrl,token)).status,403);
  db.prepare("UPDATE users SET role='cashier' WHERE id=?").run(actor.id);
  assert.equal((await req(url,token)).status,403);
  assert.equal((await req(acceptanceUrl,token)).status,403);
  db.prepare("UPDATE users SET role='owner' WHERE id=?").run(actor.id);
  sku='NEW-WOO-SKU';
  catalog.cache.fetchedAt='2000-01-01T00:00:00.000Z';
  assert.equal((await req(url+'?expectedRef='+next.data.dossierRef,token)).status,409);
  assert.equal((await req(acceptanceUrl+'?expectedRef='+acceptanceChanged.data.preparationRef,token)).status,409);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sales').get().n,0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM instore_sales').get().n,0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sale_events').get().n,0);
  assert.ok(calls.length>=1&&calls.every(x=>x==='GET products'));
});
