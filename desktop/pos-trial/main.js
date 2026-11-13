import { app, BrowserWindow, ipcMain, Menu, safeStorage, session, dialog, protocol } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { openDesktopDatabase, DesktopStore } from '../store.js';
import { acquireInstanceLease } from '../../server/instance-lease.js';
import { TrialRemote } from './trial-remote.js';
import { TrialController } from './controller.js';
import { trialSlip } from './receipt.js';

// SEPARATE executable, app ID, folder and entry point. The production remote,
// bridge, updater, credentials, renderer, and Woo plugin are not imported or
// bundled. Every simulated sync is implemented by TrialRemote in this process.
protocol.registerSchemesAsPrivileged([{scheme:'practice',privileges:{standard:true,secure:true,supportFetchAPI:true,stream:true}}]);
const qaSmoke = process.env.MANSU_PRACTICE_CI_SMOKE === '1' && process.argv.includes('--qa-smoke');
app.setName('Mansu POS Practice - NOT FOR SALES');
app.setAppUserModelId('com.mansutrendzgh.pos.practice-only');
const practiceDirectory = qaSmoke
  ? path.join(app.getPath('temp'),`mansu-practice-qa-${randomUUID()}`)
  : path.join(app.getPath('appData'),'Mansu POS Practice - NOT FOR SALES');
// Electron requires override directories to exist BEFORE setPath. Give the
// Chromium session its own folder too, never the normal POS's cache/cookies.
fs.mkdirSync(path.join(practiceDirectory,'session'),{recursive:true,mode:0o700});
app.setPath('userData',practiceDirectory);
app.setPath('sessionData',path.join(practiceDirectory,'session'));
const data = app.getPath('userData');
const root = path.dirname(fileURLToPath(import.meta.url));
const ui = path.join(root,'ui');
const index = path.join(ui,'index.html');
// A privileged, LOCAL-only origin lets the compiled ES module run with
// webSecurity on; file:// module imports would otherwise be blocked by CORS.
const indexUrl = 'practice://sample/index.html';
const rendererCsp = "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";
const printWindows = new Set();
let window, store, remote, controller, lease, closing = false;
const replyError = error => ({ok:false,error:{message:String(error?.message||'Practice operation failed.').slice(0,450),
  code:String(error?.code||'PRACTICE_ERROR').slice(0,70),status:Number(error?.status)||500}});

// Even an accidental future fetch must fail closed. Neither the installed
// main bundle nor the renderer contains an HTTP client or approved host.
globalThis.fetch = () => Promise.reject(new Error('Networking is disabled in POS Practice.'));
const single = app.requestSingleInstanceLock();
if (!single) { if(qaSmoke)app.exit(1);else app.quit(); }
else app.on('second-instance',()=>{if(window&&!window.isDestroyed()){if(window.isMinimized())window.restore();window.focus();}});

function assetFile(url) {
  if(url.protocol!=='practice:'||url.hostname!=='sample'||url.search||url.hash)return null;
  let pathname;try{pathname=decodeURIComponent(url.pathname);}catch{return null;}
  if(pathname.includes('..')||pathname.includes('\\')||pathname.includes('\0'))return null;
  const file=path.resolve(ui,`.${pathname}`);
  if(file===index||path.dirname(file)===path.join(ui,'assets')&&/^index-[\w-]+\.(?:js|css)$/.test(path.basename(file)))return file;
  return null;
}
function permittedRequest(details) {
  try {
    const url=new URL(details.url);
    if(url.protocol==='data:')return printWindows.has(details.webContentsId)&&details.resourceType==='mainFrame';
    return Boolean(assetFile(url));
  } catch {return false;}
}
async function localAsset(request) {
  let file;try{file=assetFile(new URL(request.url));}catch{/* Malformed URL. */}
  if(!file)return new Response('Not found',{status:404});
  const type=file===index?'text/html; charset=utf-8':file.endsWith('.css')?'text/css':'application/javascript';
  try{return new Response(await fs.promises.readFile(file),{headers:{'Content-Type':type,
    'X-Content-Type-Options':'nosniff','Cache-Control':'no-store',
    ...(file===index?{'Content-Security-Policy':rendererCsp}:{})}});}
  catch{return new Response('Not found',{status:404});}
}
function senderAllowed(event) {
  return Boolean(window && !window.isDestroyed() && event.sender === window.webContents &&
    event.senderFrame === window.webContents.mainFrame && event.senderFrame.url === indexUrl);
}
function closeSlip(preview) {
  printWindows.delete(preview.webContents.id);
  if(!preview.isDestroyed())preview.close();
}
async function openSlip(sale) {
  const html=trialSlip(sale);
  const preview=new BrowserWindow({show:false,width:380,height:530,title:'NOT A RECEIPT — PRACTICE',
    webPreferences:{nodeIntegration:false,nodeIntegrationInWorker:false,contextIsolation:true,sandbox:true,webSecurity:true,devTools:false}});
  printWindows.add(preview.webContents.id);
  preview.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  preview.webContents.on('will-navigate',event=>event.preventDefault());
  try {await preview.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);return preview;}
  catch(error){closeSlip(preview);throw error;}
}
async function printSample(saleId) {
  const preview=await openSlip(controller.store.sale(saleId));
  try {
    await new Promise((resolve,reject)=>preview.webContents.print({silent:false,printBackground:true},(success,reason)=>
      success?resolve():reject(new Error(reason || 'The practice print was cancelled.'))));
    return {printed:true, practiceOnly:true};
  } finally {closeSlip(preview);}
}
function registerIPC() {
  ipcMain.handle('practice:request',async(event,request)=>{
    if(!senderAllowed(event))return replyError(new Error('Only the practice window can access the sample ledger.'));
    try {return {ok:true,data:await controller.dispatch(request)};}catch(error){return replyError(error);}
  });
  ipcMain.handle('practice:print',async(event,saleId)=>{
    if(!senderAllowed(event))return replyError(new Error('Only the practice window can print a sample slip.'));
    try {return {ok:true,data:await printSample(saleId)};}catch(error){return replyError(error);}
  });
}
async function smoke() {
  // A Windows packaged-app check, without opening the printer or leaving a
  // sale in any user's data folder. SQLite/DPAPI, UI/preload and recovery run.
  const ready = await window.webContents.executeJavaScript(`new Promise((resolve,reject)=>{
    const deadline=Date.now()+15000;const next=()=>{if(document.querySelector('h1')?.textContent.includes('Practice a sale'))
      resolve(Boolean(window.mansuPractice));else if(Date.now()>deadline)reject(new Error('Practice UI did not render.'));
      else setTimeout(next,100);};next();})`);
  if(!ready)throw new Error('Packaged practice preload did not load.');
  await controller.start();
  const draft=store.prepare({idempotencyKey:randomUUID(),items:[{productId:991001,variationId:0,quantity:1}]});
  const sale=store.pay(draft.id,{method:'cash',tendered:draft.total,confirmed:true});
  if(!trialSlip(sale).includes('NOT A RECEIPT')||store.queueStatus().pending!==1)throw new Error('Practice checkout did not create a local sample event.');
  const slipWindow=await openSlip(sale);
  try {
    const printedPage=await slipWindow.webContents.executeJavaScript('document.body.innerText');
    if(!printedPage.includes('NOT A RECEIPT')||!printedPage.includes('NO PAYMENT ACCEPTED'))throw new Error('The packaged printer page lost its practice warnings.');
  } finally {closeSlip(slipWindow);}
  store.close();
  remote=new TrialRemote();store=new DesktopStore(openDesktopDatabase(data),{
    encryptString:value=>safeStorage.encryptString(value),decryptString:value=>safeStorage.decryptString(value),
  },remote,{practiceMode:true});remote.store=store;controller=new TrialController(store,remote);
  await controller.start();
  if(store.sale(sale.id).number!==sale.number||store.queueStatus().rows[0].id!==sale.id)throw new Error('Practice ledger did not survive a restart.');
  await store.sync(true);
  if(store.queueStatus().pending!==1)throw new Error('Fake offline retry lost the saved event.');
  remote.setConnected(true);await store.sync(true);
  if(store.queueStatus().pending!==0||store.sale(sale.id).wooOrderId!==null)throw new Error('Fake sync unexpectedly created a real order.');
  store.close();store=null;lease.release();lease=null;
  // Chromium may still hold its own session cache until exit on Windows.
  // The CI runner is ephemeral; never touch the installed POS's data folder.
  try { fs.rmSync(data,{recursive:true,force:true}); } catch { /* Windows releases open cache files on process exit. */ }
  app.exit(0);
}
async function start() {
  if(process.platform!=='win32'||!safeStorage.isEncryptionAvailable()) {
    throw new Error('POS Practice requires Windows DPAPI for protected sample storage. No plaintext fallback is permitted.');
  }
  Menu.setApplicationMenu(null);
  session.defaultSession.webRequest.onBeforeRequest((details,callback)=>callback({cancel:!permittedRequest(details)}));
  session.defaultSession.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
  session.defaultSession.on('will-download',event=>event.preventDefault());
  protocol.handle('practice',localAsset);
  lease=acquireInstanceLease({dataDir:data,mode:'practice'});
  const codec={encryptString:value=>safeStorage.encryptString(value),decryptString:value=>safeStorage.decryptString(value)};
  try { remote=new TrialRemote();store=new DesktopStore(openDesktopDatabase(data),codec,remote,{practiceMode:true});remote.store=store;controller=new TrialController(store,remote); }
  catch(error){lease.release();lease=null;throw error;}
  registerIPC();
  window=new BrowserWindow({width:1360,height:850,minWidth:720,minHeight:620,show:false,
    backgroundColor:'#f6f8f8',title:'Mansu POS Practice — NOT FOR SALES',
    webPreferences:{preload:path.join(root,'preload.cjs'),contextIsolation:true,nodeIntegration:false,
      nodeIntegrationInWorker:false,sandbox:true,webSecurity:true,devTools:false}});
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  window.webContents.on('will-navigate',event=>event.preventDefault());
  window.webContents.on('will-attach-webview',event=>event.preventDefault());
  window.webContents.on('before-input-event',(event,input)=>{
    if(input.type==='keyDown'&&input.control&&input.key.toLowerCase()==='p')event.preventDefault();
  });
  window.once('ready-to-show',()=>{if(!qaSmoke)window.show();});
  await window.loadURL(indexUrl);
  if(qaSmoke)await smoke();
}
if(single)app.whenReady().then(start).catch(error=>{
  if(qaSmoke){console.error(error);app.exit(1);return;}
  dialog.showErrorBox('POS Practice could not start',error.message);app.quit();
});
app.on('window-all-closed',()=>app.quit());
app.on('before-quit',event=>{
  if(store?.syncing&&!closing){event.preventDefault();closing=true;const until=Date.now()+25000;
    const timer=setInterval(()=>{if(!store?.syncing||Date.now()>until){clearInterval(timer);app.quit();}},250);return;}
  try{store?.close();}catch{/* The original sample event remains in SQLite on crash. */}store=null;
  try{lease?.release();}catch{/* The OS releases the instance lock. */}lease=null;
});
