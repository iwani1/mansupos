'use strict';

// Mansu POS for Windows: a native till window for the LIVE online POS.
// Unlike desktop/main.js (the superseded offline till) this app has no SQLite,
// stock allocation, offline sale, sync queue or update feed. The pinned HTTPS
// POS service is the only place a sale, stock change or cash movement happens,
// and it enforces staff permissions and its own trading gates.
const path = require('node:path');
const { app, BrowserWindow, dialog, Menu, net, session } = require('electron');
const { POS_ORIGIN, posRoot, requestAllowed, downloadAllowed, downloadName, verifyPos: verifyWith } = require('./policy.cjs');

// Chromium's network stack: honours the Windows proxy settings and the
// Windows certificate store, exactly like the till window itself.
const verifyPos = () => verifyWith((url, options) => net.fetch(url, options));

const APP_NAME = 'Mansu POS';
const smoke = process.env.MANSU_ONLINE_CI_SMOKE === '1' && process.argv.includes('--qa-smoke');
// Persistent so held carts and screen preferences survive a restart, like the
// browser. HTTP caching stays off and the service worker is refused, so no
// stale catalogue or offline copy of the POS is ever shown.
const partition = 'persist:mansu-pos-till';
const CHECK_EVERY_MS = 15000;
const BANNER_ID = 'mansu-till-connection-banner';
let window, timer, quitting = false, online = true, serverInfo = { readOnly: false, version: '' };

app.setAppUserModelId('com.mansutrendzgh.pos.online');
const single = app.requestSingleInstanceLock();
if (!single) { if (smoke) app.exit(1); else app.quit(); }
else app.on('second-instance', () => {
  if (window && !window.isDestroyed()) {
    if (window.isMinimized()) window.restore();
    window.focus();
  }
});

function windowTitle() {
  if (!online) return `${APP_NAME} — CONNECTION LOST · do not take payment`;
  return serverInfo.readOnly ? `${APP_NAME} — read-only (sales switched off on the server)` : APP_NAME;
}

// The banner is drawn in an isolated world: it never touches the page's own
// scripts and is removed as soon as the POS answers again.
const bannerScript = show => show ? `(() => {
  if (document.getElementById('${BANNER_ID}')) return;
  const bar = document.createElement('div');
  bar.id = '${BANNER_ID}';
  bar.setAttribute('role', 'alert');
  bar.textContent = 'Connection to the POS lost. Do not take payment until this message goes away. If you pressed Confirm, check Sales before trying again.';
  Object.assign(bar.style, { position: 'fixed', zIndex: 2147483647, left: 0, right: 0, top: 0, padding: '10px 16px',
    background: '#b42318', color: '#fff', font: '600 15px/1.4 system-ui, sans-serif', textAlign: 'center' });
  document.documentElement.appendChild(bar);
})()` : `document.getElementById('${BANNER_ID}')?.remove()`;

async function setOnline(next) {
  if (next === online || !window || window.isDestroyed()) return;
  online = next;
  window.setTitle(windowTitle());
  try { await window.webContents.executeJavaScriptInIsolatedWorld(1001, [{ code: bannerScript(!online) }]); }
  catch { /* Page is mid-load; the next check redraws it. */ }
}

async function checkConnection() {
  try { serverInfo = await verifyPos(); await setOnline(true); window?.setTitle(windowTitle()); }
  catch { await setOnline(false); }
}

// Before the window exists (or after a failed page load) ask, rather than
// showing a blank or stale till.
async function waitForPos(problem) {
  for (;;) {
    try {
      if (problem) throw new Error(problem);
      serverInfo = await verifyPos(); return true;
    } catch (error) {
      problem = null;
      if (quitting) return false;
      const { response } = await dialog.showMessageBox(window && !window.isDestroyed() && window.isVisible() ? window : undefined, {
        type: 'warning', title: APP_NAME, buttons: ['Try again', 'Close'], defaultId: 0, cancelId: 1, noLink: true,
        message: 'Cannot reach the POS',
        detail: `${error.message}\n\nThis till only works online: nothing can be sold or queued while it is disconnected. Check the internet connection, then try again.`,
      });
      if (response !== 0) { quitting = true; app.quit(); return false; }
    }
  }
}

async function loadPos(problem) {
  if (quitting || !window || window.isDestroyed()) return;
  if (!(await waitForPos(typeof problem === 'string' ? problem : null))) return;
  online = true;
  window.setTitle(windowTitle());
  await window.loadURL(`${POS_ORIGIN}/`).catch(() => { /* did-fail-load handles it */ });
}

function about() {
  dialog.showMessageBox(window, {
    type: 'info', title: APP_NAME, message: `${APP_NAME} for Windows ${app.getVersion()}`,
    detail: `Connected to ${POS_ORIGIN}${serverInfo.version ? ` (POS ${serverInfo.version})` : ''}.\n\n` +
      'Every sale is recorded on the online POS and the website at the moment it is made. ' +
      'Nothing is stored for later: if the connection drops, wait for it to come back before taking payment.',
  });
}

async function start() {
  const posSession = session.fromPartition(partition, { cache: false });
  posSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !requestAllowed(details) });
  });
  posSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  posSession.setPermissionCheckHandler(() => false);
  posSession.on('will-download', (event, item) => {
    if (!downloadAllowed(item.getURL())) { event.preventDefault(); return; }
    // No setSavePath: Windows shows its normal Save As dialog.
    item.setSaveDialogOptions({
      title: 'Save export',
      defaultPath: path.join(app.getPath('downloads'), downloadName(item.getFilename())),
    });
  });

  window = new BrowserWindow({
    title: APP_NAME, width: 1360, height: 870, minWidth: 760, minHeight: 620,
    backgroundColor: '#1c1920', show: false, autoHideMenuBar: false,
    webPreferences: {
      partition, contextIsolation: true, nodeIntegration: false,
      nodeIntegrationInWorker: false, sandbox: true, webSecurity: true,
      webviewTag: false, devTools: !app.isPackaged, spellcheck: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (!posRoot(url)) event.preventDefault(); });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.on('page-title-updated', event => { event.preventDefault(); window.setTitle(windowTitle()); });
  window.webContents.on('did-finish-load', () => { if (!online) setOnline(true); });
  window.webContents.on('did-fail-load', (_event, code, description, _url, mainFrame) => {
    if (mainFrame && code !== -3 && !smoke) setImmediate(() => loadPos(`The POS page did not load (${description}).`));
  });
  window.webContents.on('render-process-gone', () => {
    if (!smoke && !quitting) setImmediate(() => loadPos('The POS window stopped responding.'));
  });
  window.once('ready-to-show', () => { if (!quitting) window.show(); });

  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'POS', submenu: [
      { label: 'Reload', accelerator: 'Ctrl+R', click: () => loadPos() },
      { type: 'separator' },
      { role: 'togglefullscreen', label: 'Full screen', accelerator: 'F11' },
      { role: 'zoomIn', label: 'Larger text', accelerator: 'Ctrl+=' },
      { role: 'zoomOut', label: 'Smaller text', accelerator: 'Ctrl+-' },
      { role: 'resetZoom', label: 'Normal text size', accelerator: 'Ctrl+0' },
      { type: 'separator' }, { role: 'quit', label: 'Close' },
    ] },
    { label: 'Help', submenu: [{ label: `About ${APP_NAME}`, click: about }] },
  ]));

  if (smoke) {
    // Packaged Windows runner checks the real Electron window and request
    // policy without contacting the POS or entering credentials.
    await Promise.race([
      window.loadURL('about:blank'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('QA blank window did not load.')), 10000)),
    ]);
    const isolated = await Promise.race([
      window.webContents.executeJavaScript(
        "document.readyState === 'complete' && typeof require === 'undefined' && !window.mansuDesktop && !window.mansuPractice"),
      new Promise((_, reject) => setTimeout(() => reject(new Error('QA renderer did not respond.')), 10000)),
    ]);
    const sells = requestAllowed({ url: `${POS_ORIGIN}/api/sales/prepare`, method: 'POST', resourceType: 'xhr' });
    const offlineSync = requestAllowed({ url: `${POS_ORIGIN}/api/desktop/sync`, method: 'POST', resourceType: 'xhr' });
    const otherSite = requestAllowed({ url: 'https://example.com/', method: 'GET', resourceType: 'mainFrame' });
    if (!isolated || !sells || offlineSync || otherSite) throw new Error('Packaged till sandbox or request policy failed.');
    console.log('Packaged Mansu POS window opened sandboxed; online checkout allowed, offline sync and other sites blocked; no real network request.');
    app.exit(0);
    return;
  }

  await loadPos();
  timer = setInterval(checkConnection, CHECK_EVERY_MS);
  timer.unref();
}

if (single) app.whenReady().then(start).catch(error => {
  if (smoke) { console.error(error); app.exit(1); return; }
  dialog.showErrorBox(APP_NAME, error.message);
  app.quit();
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { quitting = true; if (timer) clearInterval(timer); });
