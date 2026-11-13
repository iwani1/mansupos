import { app, BrowserWindow, dialog, ipcMain, protocol, session, safeStorage } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDesktopDatabase, DesktopStore } from './store.js';
import { DesktopRemote } from './remote.js';
import { desktopDispatch } from './bridge.js';
import { cacheProductImages } from './image-cache.js';
import { acquireInstanceLease } from '../server/instance-lease.js';

protocol.registerSchemesAsPrivileged([{ scheme:'app', privileges:{ standard:true,secure:true,supportFetchAPI:true,stream:true } }]);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = app.getPath('userData');
const csp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: app:; connect-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'self'; form-action 'none'";
const mime = { '.html':'text/html; charset=utf-8', '.js':'application/javascript', '.css':'text/css', '.svg':'image/svg+xml',
  '.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.woff2':'font/woff2','.ico':'image/x-icon',
  '.webmanifest':'application/manifest+json' };
let window, store, lease, imageWork, updater, updating = false, updateReady = false, waitingForSync = false;
const replyError = error => ({ ok:false, error:{ message: String(error?.message || 'Desktop operation failed.').slice(0,500),
  code: String(error?.code || 'DESKTOP_ERROR').slice(0,80), status: Number(error?.status) || 500 } });
const single = app.requestSingleInstanceLock();
if (!single) app.quit();
else app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });

async function asset(request) {
  let url;
  try { url = new URL(request.url); } catch { return new Response('Not found',{status:404}); }
  if (url.hostname !== 'mansu' || url.search || url.hash) return new Response('Not found',{status:404});
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { return new Response('Not found',{status:404}); }
  if (pathname.includes('..') || pathname.includes('\\') || pathname.includes('\0')) return new Response('Not found',{status:404});
  const image = /^\/image\/([a-f0-9]{64}\.(?:jpg|png|webp))$/.exec(pathname);
  const file = image ? path.join(data,'images',image[1]) :
    path.resolve(root,'dist',pathname === '/' ? './index.html' : `.${pathname}`);
  if (!image && !file.startsWith(path.join(root,'dist')+path.sep)) return new Response('Not found',{status:404});
  const type = mime[path.extname(file).toLowerCase()];
  if (!type) return new Response('Not found',{status:404});
  try { return new Response(await fs.readFile(file),{headers:{'Content-Type':type,'X-Content-Type-Options':'nosniff',
    'Cache-Control':'no-store',...(type.startsWith('text/html')?{'Content-Security-Policy':csp}:{})}}); }
  catch { return new Response('Not found',{status:404}); }
}

function cacheImages() {
  if (imageWork) return;
  imageWork = cacheProductImages(store,path.join(data,'images'),fetch,() => {
    if (window && !window.isDestroyed()) window.webContents.send('mansu:images');
  }).catch(() => {}).finally(() => { imageWork = null; });
}
function senderAllowed(event) {
  return Boolean(window && !window.isDestroyed() && event.sender === window.webContents &&
    event.senderFrame === window.webContents.mainFrame && event.senderFrame.url === 'app://mansu/index.html');
}
function registerIPC() {
  ipcMain.handle('mansu:request', async (event, request) => {
    if (!senderAllowed(event)) return replyError(new Error('Untrusted frame.'));
    try {
      const result = await desktopDispatch(store,request);
      if (['/api/desktop/connect','/api/desktop/refresh','/api/desktop/allocate'].includes(request.path)) cacheImages();
      return { ok:true,data:result };
    } catch (error) { return replyError(error); }
  });
  ipcMain.handle('mansu:updates', async (event, action) => {
    if (!senderAllowed(event)) return replyError(new Error('Untrusted frame.'));
    try {
      if (action === 'status') return { ok:true,data:{ enabled:Boolean(updater),ready:updateReady,version:app.getVersion(),
        message:updater?'Only a signed public release can be installed. Never update during a sale.':'Automatic updates are disabled until a signed public GitHub Release is reviewed and approved.' } };
      if (!updater) throw new Error('No signed update feed has been approved for this installer. Keep using the current version.');
      if (action === 'check') { const result = await updater.checkForUpdates(); return {ok:true,data:{available:Boolean(result?.updateInfo && result.updateInfo.version !== app.getVersion()),version:result?.updateInfo?.version}}; }
      if (action === 'download') { await updater.downloadUpdate(); return {ok:true,data:{ready:updateReady}}; }
      if (action === 'install') {
        if (updating || store.syncing || store.queueStatus().pending) throw new Error('Finish the current transaction and synchronize every pending event before installing an update.');
        if (!updateReady) throw new Error('Download and verify the signed installer first.');
        updating = true;
        setImmediate(() => updater.quitAndInstall(false,true));
        return {ok:true,data:{installing:true}};
      }
      throw new Error('Unsupported update action.');
    } catch (error) { return replyError(error); }
  });
}
async function configureUpdates() {
  let policy;
  try { policy = JSON.parse(await fs.readFile(path.join(root,'desktop','update-policy.json'),'utf8')); } catch { return; }
  if (!app.isPackaged || process.platform !== 'win32' || policy.signed !== true) return;
  ({ autoUpdater:updater } = await import('electron-updater'));
  updater.autoDownload = false; updater.autoInstallOnAppQuit = false;
  updater.on('update-downloaded', () => { updateReady = true; });
  updater.on('error', () => { updateReady = false; });
}
async function start() {
  if (process.platform !== 'win32' || !safeStorage.isEncryptionAvailable()) {
    throw new Error('Protected offline storage requires Windows DPAPI. This Windows desktop build will not store credentials using a plaintext fallback.');
  }
  const codec = { encryptString: value => safeStorage.encryptString(value), decryptString: value => safeStorage.decryptString(value) };
  lease = acquireInstanceLease({dataDir:data,mode:'desktop'});
  try { store = new DesktopStore(openDesktopDatabase(data),codec,new DesktopRemote()); }
  catch (error) { lease.release(); throw error; }
  protocol.handle('app',asset);
  // Only the main process calls the separate HTTPS trading server. No network
  // request can originate from renderer content, including product images.
  session.defaultSession.webRequest.onBeforeRequest((details,callback) => {
    callback({cancel:/^https?:/i.test(details.url)});
  });
  session.defaultSession.setPermissionRequestHandler((_contents,_permission,callback) => callback(false));
  await configureUpdates();registerIPC();
  window = new BrowserWindow({ width:1360,height:870,minWidth:760,minHeight:620,
    backgroundColor:'#1c1920',title:'MansutRENDZGH POS',show:false,
    icon:path.join(root,'dist','icons','mansu-512.png'),
    webPreferences:{preload:path.join(root,'desktop','preload.cjs'),contextIsolation:true,nodeIntegration:false,
      nodeIntegrationInWorker:false,sandbox:true,webSecurity:true,devTools:!app.isPackaged} });
  window.webContents.setWindowOpenHandler(() => ({action:'deny'}));
  window.webContents.on('will-navigate',event => event.preventDefault());
  window.webContents.on('will-attach-webview',event => event.preventDefault());
  window.once('ready-to-show',()=>window.show());
  await window.loadURL('app://mansu/index.html');
  const timer = setInterval(() => {
    try { if (store.session().user && store.queueStatus().pending && !store.syncing) store.sync().catch(()=>{}); }
    catch { /* Sign-in/lease expiry: pending rows remain durable until re-authentication. */ }
  },60000);
  timer.unref();
}
if (single) app.whenReady().then(start).catch(error => {
  dialog.showErrorBox('MansutRENDZGH POS could not start',error.message);
  app.quit();
});
app.on('window-all-closed',()=>app.quit());
app.on('before-quit',event => {
  if (store?.syncing && !waitingForSync) {
    event.preventDefault();waitingForSync=true;
    const until=Date.now()+25000;
    const timer=setInterval(()=>{
      if (!store?.syncing || Date.now()>until) {clearInterval(timer);app.quit();}
    },250);
    return;
  }
  try { store?.close(); } catch { /* An uncertain remote event is still in the durable local queue. */ }
  try { lease?.release(); } catch { /* The OS releases the SQLite lease on process exit. */ }
});
