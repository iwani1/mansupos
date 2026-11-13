import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomBytes, randomUUID, createHash, createHmac, createCipheriv, createDecipheriv } from 'node:crypto';
import { openDesktopDatabase, DesktopStore } from '../desktop/store.js';
import { tradingOrigin } from '../desktop/trading-origin.js';
import { desktopDispatch } from '../desktop/bridge.js';
import { AppError } from '../server/errors.js';
import { openBrowser, recordFailure } from './browser-helpers.mjs';

// A SELF-CONTAINED renderer/SQLite integration test. The central service and
// Woo are in-memory fakes. It never connects to the real store, enables a
// production gate, launches Electron, or installs the reservation plugin.
const dist = path.resolve('dist');
if (!fs.readFileSync(path.join(dist,'index.html'),'utf8').includes('./assets/')) {
  throw new Error('Build the desktop UI with npm run build:desktop before this test.');
}
const fileType = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.svg':'image/svg+xml',
  '.png':'image/png', '.woff2':'font/woff2', '.webmanifest':'application/manifest+json' };
const server = http.createServer((req,res) => {
  const url = new URL(req.url,'http://localhost');
  let pathname;
  try { pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname); }
  catch { res.writeHead(400).end();return; }
  const file = path.resolve(dist, `.${pathname}`);
  if (!file.startsWith(dist+path.sep) || !fileType[path.extname(file)]) { res.writeHead(404).end();return; }
  try { res.writeHead(200,{'Content-Type':fileType[path.extname(file)],'Cache-Control':'no-store'}).end(fs.readFileSync(file)); }
  catch { res.writeHead(404).end(); }
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
const data=fs.mkdtempSync(path.join(os.tmpdir(),'mansu-desktop-browser-'));
const key=randomBytes(32);
const codec={encryptString(text){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);
  return Buffer.concat([iv,cipher.update(text,'utf8'),cipher.final(),cipher.getAuthTag()]);},
  decryptString(blob){const decipher=createDecipheriv('aes-256-gcm',key,blob.subarray(0,12));
    decipher.setAuthTag(blob.subarray(-16));return Buffer.concat([decipher.update(blob.subarray(12,-16)),decipher.final()]).toString('utf8');}};
const ownerId=randomUUID(),secret='b'.repeat(64),expiry=new Date(Date.now()+2*3600000).toISOString();
const product={id:101,name:'Private sample shirt',type:'simple',sku:'SAMPLE-101',barcode:'SAMPLE-101',
  price:1200,image:'',category:'Tops',categories:['Tops'],stockSource:'product',manageStock:true,
  backorders:'no',backordersAllowed:false,stockStatus:'instock',purchasable:true,soldIndividually:false,variations:[]};
const catalog={products:[product],source:'woocommerce',complete:true,stale:false,fetchedAt:new Date().toISOString()};
let connected=true,syncCalls=0;
const remote={validateOrigin:tradingOrigin,expectedService:{mode:'live',storeUrl:'https://www.mansutrendzgh.com'},
  async request(_origin,_token,resource,_method,body){
  if(!connected)throw new AppError('Fake central service is offline.',503,'SYNC_OFFLINE');
  if(resource==='/auth/login')return {user:{id:ownerId,username:'owner',name:'Owner',role:'owner',mustChangePassword:false},
    token:'fake-private-session',config:{mode:'live',storeUrl:'https://www.mansutrendzgh.com'}};
  if(resource==='/desktop/enroll')return {deviceId:body.deviceId,enrolled:true,deviceSecret:secret};
  if(resource.startsWith('/desktop/bootstrap'))return {deviceId:resource.split('=')[1],canSell:true,canWholesale:false,
    leaseExpiresAt:expiry,catalog,wholesalePrices:[],grants:[{stockKey:'101:0',productId:101,variationId:0,remaining:2,revision:1,expiresAt:expiry}]};
  if(resource==='/desktop/sync'){
    syncCalls++;
    const {event,signature}=body;
    assert.equal(signature,createHmac('sha256',secret).update(JSON.stringify(event)).digest('hex'));
    return {id:event.id,fingerprint:createHash('sha256').update(JSON.stringify(event)).digest('hex'),status:'acked',wooOrderId:9001};
  }
  throw new Error(`Unexpected fake central request ${resource}`);
}};
const store=new DesktopStore(openDesktopDatabase(data),codec,remote);
let browser,page,pageErrors=[];
try {
  ({browser,page,pageErrors}=await openBrowser({viewport:{width:1360,height:870},reducedMotion:'reduce'}));
  await page.exposeFunction('__desktopInvoke',async request=>{
    try {return {ok:true,data:await desktopDispatch(store,request)};}
    catch(e){return {ok:false,error:{message:e.message,code:e.code,status:e.status||500}};}
  });
  await page.addInitScript(() => {
    window.mansuDesktop={
      request:async(path,method='GET',body)=>{
        const reply=await window.__desktopInvoke({path,method,body});
        if(reply.ok)return reply.data;
        const error=new Error(reply.error.message);error.code=reply.error.code;error.status=reply.error.status;throw error;
      },
      updates:async()=>({enabled:false,ready:false,version:'1.2.3',message:'QA fake: updates disabled.'}),
      onImages:()=>()=>{},
    };
    window.confirm=()=>true;
  });
  page.on('request',request=>{
    if(new URL(request.url()).origin!==base) throw new Error(`Desktop renderer tried an external URL: ${request.url()}`);
  });
  await page.goto(base,{waitUntil:'networkidle'});
  await page.getByRole('heading',{name:'Connect the separate trading service'}).waitFor();
  assert.equal(store.session().config.writesEnabled,false);
  await page.getByLabel('Approved trading POS HTTPS address').fill('https://trading.mansutrendzgh.com');
  await page.getByLabel('Staff username').fill('owner');
  await page.getByLabel('Password').fill('Super long offline passphrase 2026!');
  await page.getByRole('button',{name:'Connect securely'}).click();
  await page.getByRole('heading',{name:'Counter overview'}).waitFor();
  await page.getByText('Reserved checkout ready').waitFor();
  assert.equal(store.session().config.writesEnabled,true);

  // Logging out does not wipe the ledger; offline sign-in and checkout use
  // only the fake native bridge and previously held local allocation.
  await page.getByRole('button',{name:'Sign out'}).click();
  await page.getByRole('heading',{name:'Sign in to this computer'}).waitFor();
  connected=false;
  await page.context().setOffline(true);
  await page.getByLabel('Staff username').fill('owner');
  await page.getByLabel('Password').fill('Super long offline passphrase 2026!');
  await page.getByRole('button',{name:'Unlock local ledger'}).click();
  await page.getByRole('heading',{name:'Counter overview'}).waitFor();
  await page.locator('.desktop-rail nav').getByRole('button',{name:'Point of sale'}).click();
  await page.locator('.product-card').filter({hasText:'Private sample shirt'}).click();
  await page.getByRole('button',{name:/Review offline sale/}).click();
  await page.getByRole('dialog',{name:'Complete payment'}).waitFor();
  await page.getByRole('button',{name:'Exact amount'}).click();
  await page.getByRole('checkbox',{name:/received and counted this cash/}).check();
  await page.getByRole('button',{name:'Commit local cash sale'}).click();
  await page.getByRole('dialog',{name:'Sale receipt'}).waitFor();
  assert.equal(store.queueStatus().pending,1);
  assert.equal(store.catalog().products[0].stock,1);
  assert.equal(syncCalls,0);
  await page.getByRole('button',{name:'Done'}).click();
  await page.locator('.desktop-rail nav').getByRole('button',{name:/Sync & conflicts/}).click();
  await page.getByText('Saved locally before network use').waitFor();
  await page.context().setOffline(false);connected=true;
  await page.getByRole('button',{name:'Sync now'}).click();
  await page.waitForFunction(() => document.querySelector('.desktop-queue-row')?.textContent?.includes('acked'));
  assert.equal(syncCalls,1);assert.equal(store.queueStatus().pending,0);
  assert.equal(store.sales().sales[0].wooOrderId,9001);
  if(pageErrors.length)throw new Error(`Browser page errors: ${pageErrors.join(' | ')}`);
  console.log('Desktop UI → offline SQLite cash receipt → signed SAME-ID sync: isolated browser fixture passed. No Electron runtime or live Woo tested.');
} catch(error){if(page)await recordFailure(page,error,'desktop-browser',pageErrors);throw error;}
finally {
  if(browser)await browser.close();
  store.close();
  fs.rmSync(data,{recursive:true,force:true});
  await new Promise(resolve=>server.close(resolve));
}
