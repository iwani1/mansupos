import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { openDesktopDatabase, DesktopStore } from '../desktop/store.js';
import { TrialRemote } from '../desktop/pos-trial/trial-remote.js';
import { TrialController } from '../desktop/pos-trial/controller.js';
import { trialSlip } from '../desktop/pos-trial/receipt.js';
import { openBrowser, recordFailure } from './browser-helpers.mjs';

const ui=path.resolve('desktop/pos-trial/bundle/ui');
if(!fs.readFileSync(path.join(ui,'index.html'),'utf8').includes("connect-src 'none'")) {
  throw new Error('Build the separate practice app before its renderer browser test.');
}
const contentType={'.html':'text/html','.js':'text/javascript','.css':'text/css'};
const server=http.createServer((req,res)=>{
  let route;try{route=decodeURIComponent(new URL(req.url,'http://localhost').pathname);}catch{res.writeHead(404).end();return;}
  const file=path.resolve(ui,`.${route==='/'?'/index.html':route}`);
  if(!file.startsWith(ui+path.sep)||!contentType[path.extname(file)]){res.writeHead(404).end();return;}
  try{res.writeHead(200,{'Content-Type':contentType[path.extname(file)],'Cache-Control':'no-store'}).end(fs.readFileSync(file));}
  catch{res.writeHead(404).end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'mansu-practice-browser-'));
const key=randomBytes(32);
const codec={encryptString(text){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);
  return Buffer.concat([iv,cipher.update(text,'utf8'),cipher.final(),cipher.getAuthTag()]);},
  decryptString(blob){const decipher=createDecipheriv('aes-256-gcm',key,blob.subarray(0,12));
    decipher.setAuthTag(blob.subarray(-16));return Buffer.concat([decipher.update(blob.subarray(12,-16)),decipher.final()]).toString('utf8');}};
let remote,store,controller,printCount=0;
function open(){remote=new TrialRemote();store=new DesktopStore(openDesktopDatabase(directory),codec,remote,{practiceMode:true});
  remote.store=store;controller=new TrialController(store,remote);}
open();
let browser,page,pageErrors=[];
const external=[];
try{
  ({browser,page,pageErrors}=await openBrowser({viewport:{width:1360,height:870},reducedMotion:'reduce'}));
  await page.exposeFunction('__practiceInvoke',async request=>{
    try{return {ok:true,data:await controller.dispatch(request)};}
    catch(error){return {ok:false,error:{message:error.message,status:error.status,code:error.code}};}
  });
  await page.exposeFunction('__practicePrint',async id=>{
    try{const html=trialSlip(store.sale(id));
      assert.match(html,/NO PAYMENT ACCEPTED/);assert.match(html,/NOT A RECEIPT/);printCount++;
      return {ok:true,data:{printed:true,practiceOnly:true}};
    }catch(error){return {ok:false,error:{message:error.message}};}
  });
  await page.addInitScript(()=>{
    window.mansuPractice={request:request=>window.__practiceInvoke(request),print:id=>window.__practicePrint(id)};
  });
  page.on('request',request=>{if(new URL(request.url()).origin!==base)external.push(request.url());});
  await page.goto(base,{waitUntil:'networkidle'});
  await page.getByRole('heading',{name:'Practice a sale. Never make one.'}).waitFor();
  assert.match(await page.locator('body').innerText(),/Never make one|NOT FOR SALES/);
  await page.getByRole('button',{name:'Open sample till'}).click();
  await page.getByRole('heading',{name:'Practice till'}).waitFor();
  assert.equal(await page.getByText('Fake service: OFFLINE').count(),1);
  const scanner=page.getByRole('textbox',{name:'Scan SAMPLE barcode or SKU'});
  await scanner.fill('REAL-SHOP-ITEM');await scanner.press('Enter');
  await page.getByText('A real shop barcode cannot be used.',{exact:false}).waitFor();
  await scanner.fill('QA-SCARF-01');await scanner.press('Enter');
  await page.locator('.practice-cart-line').getByText('SAMPLE scarf',{exact:false}).waitFor();
  await page.getByRole('button',{name:/Review simulated checkout/}).click();
  const review=page.getByRole('dialog',{name:'Review simulated checkout'});
  await review.waitFor();
  assert.equal(await review.getByRole('button',{name:/Save sample event offline/}).isDisabled(),true);
  await review.getByRole('checkbox',{name:/I did not accept money or release goods/}).check();
  await review.getByRole('button',{name:/Save sample event offline/}).click();
  const slip=page.getByRole('dialog',{name:'Practice slip'});await slip.waitFor();
  assert.match(await slip.innerText(),/NOT A RECEIPT/);
  assert.match(store.sales().sales[0].number,/^PRACTICE-/);
  const eventId=store.queueStatus().rows[0].id;
  assert.equal(store.queueStatus().pending,1);
  await slip.getByRole('button',{name:/Print NOT A RECEIPT/}).click();
  assert.equal(printCount,1);
  await slip.getByRole('button',{name:'Done'}).click();
  await page.getByRole('button',{name:/Fake sync & recovery/}).click();
  await page.getByRole('button',{name:/Attempt fake sync/}).click();
  await page.getByText('RETRY',{exact:true}).waitFor();
  assert.equal(store.queueStatus().rows[0].id,eventId);
  assert.equal(store.queueStatus().rows[0].attempts,1);
  store.close();open();
  await page.reload({waitUntil:'networkidle'});
  await page.getByRole('button',{name:'Open sample till'}).click();
  await page.getByRole('button',{name:'Saved practice slips'}).click();
  await page.getByText(store.sale(eventId).number).waitFor();
  assert.equal(store.queueStatus().pending,1);
  assert.equal(store.queueStatus().rows[0].id,eventId);
  assert.equal(store.catalog().products[0].stock,1);
  await page.getByRole('button',{name:/Fake sync & recovery/}).click();
  assert.equal(await page.getByText('Fake service: OFFLINE').count(),1);
  await page.getByRole('button',{name:'Fake CONNECTED'}).click();
  await page.getByRole('button',{name:/Attempt fake sync/}).click();
  await page.getByText('FAKE ACK', { exact: true }).waitFor();
  assert.equal(store.queueStatus().pending,0);
  assert.equal(store.sale(eventId).wooOrderId,null);
  assert.deepEqual(external,[]);
  assert.deepEqual(pageErrors,[]);
  console.log('Practice renderer → SAMPLE scan → simulated offline commit → NOT A RECEIPT → restart/retry SAME ID → fake acknowledgement. No real network request or printer was used.');
}catch(error){if(page)await recordFailure(page,error,'pos-trial-browser',pageErrors);throw error;}
finally{if(browser)await browser.close();store.close();fs.rmSync(directory,{recursive:true,force:true});await new Promise(resolve=>server.close(resolve));}
