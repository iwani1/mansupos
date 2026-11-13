'use strict';

// Native ONLINE POS pilot shell. Unlike desktop/main.js this application has
// no SQLite, device allocation, offline sale, sync queue or update provider.
// The deployed POS service is the sole source of authentication/catalogue and
// the only possible checkout path (which this QA build blocks altogether).
const { app, BrowserWindow, dialog, Menu, session } = require('electron');
const { PILOT_ORIGIN, pilotRoot, requestAllowed, verifyPilot } = require('./policy.cjs');

const title = 'Mansu POS Online — READ-ONLY PILOT · NO CHECKOUT';
const smoke = process.env.MANSU_ONLINE_CI_SMOKE === '1' && process.argv.includes('--qa-smoke');
const partition = 'mansu-online-pilot'; // no "persist:": no disk session, cached catalogue or service worker
let window, timer, closing = false;

app.setAppUserModelId('com.mansutrendzgh.pos.online-pilot');
const single = app.requestSingleInstanceLock();
if (!single) { if (smoke) app.exit(1); else app.quit(); }
else app.on('second-instance', () => {
  if (window && !window.isDestroyed()) {
    if (window.isMinimized()) window.restore();
    window.focus();
  }
});

function disconnected(message) {
  if (closing || smoke) return;
  closing = true;
  if (timer) clearInterval(timer);
  // Never leave an old stock display or a cart on screen after losing the POS
  // service. A request may have reached a future approved server before its
  // response was lost: review Sales on reconnection, do not assume it failed.
  if (window && !window.isDestroyed()) { window.hide(); window.webContents.stop(); }
  dialog.showErrorBox('Online POS connection required',
    `${message}\n\nThe app cannot record an offline sale or queue one for later. If a request was interrupted, check the server's Sales history before retrying. Reopen the app after reconnecting.`);
  app.quit();
}

async function reloadFromService() {
  if (closing || !window || window.isDestroyed()) return;
  try { await verifyPilot(); await window.loadURL(`${PILOT_ORIGIN}/`); }
  catch (error) { disconnected(error.message); }
}

async function start() {
  // This is an in-memory, cache-disabled session, independent of both the web
  // browser and the older offline POS. A fresh launch requires online sign-in.
  const posSession = session.fromPartition(partition, { cache: false });
  posSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !requestAllowed(details) });
  });
  posSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  posSession.setPermissionCheckHandler(() => false);
  posSession.on('will-download', event => event.preventDefault());

  window = new BrowserWindow({
    title, width: 1360, height: 870, minWidth: 760, minHeight: 620,
    backgroundColor: '#1c1920', show: false,
    webPreferences: {
      partition, contextIsolation: true, nodeIntegration: false,
      nodeIntegrationInWorker: false, sandbox: true, webSecurity: true,
      webviewTag: false, devTools: !app.isPackaged, spellcheck: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (!pilotRoot(url)) event.preventDefault(); });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.on('page-title-updated', event => { event.preventDefault(); window.setTitle(title); });
  window.webContents.on('did-fail-load', (_event, code, description, _url, mainFrame) => {
    if (mainFrame && code !== -3) disconnected(`The pilot page could not be loaded: ${description}.`);
  });
  window.webContents.on('render-process-gone', () => disconnected('The POS window stopped responding.'));
  window.once('ready-to-show', () => { if (!closing) window.show(); });

  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Online POS', submenu: [
      { label: 'Reconnect and reload', accelerator: 'Ctrl+R', click: reloadFromService },
      { type: 'separator' }, { role: 'quit', label: 'Close' },
    ] },
    { label: 'Help', submenu: [{ label: 'About this pilot', click: () => dialog.showMessageBox(window, {
      type: 'info', title, message: title,
      detail: `Connected only to ${PILOT_ORIGIN}/. Sales, stock edits and payments are locked in this Windows QA build. No offline sales or later sync.`,
    }) }] },
  ]));

  if (smoke) {
    // Packaged Windows runner checks the actual Electron window/preferences
    // without contacting the pilot or accepting credentials. Navigate first:
    // executeJavaScript on a newly constructed, un-navigated about:blank window
    // may wait forever for did-finish-load. No fixture or remote host is loaded.
    await Promise.race([
      window.loadURL('about:blank'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('QA blank window did not load.')), 10000)),
    ]);
    const isolated = await Promise.race([
      window.webContents.executeJavaScript(
        "document.readyState === 'complete' && typeof require === 'undefined' && !window.mansuDesktop && !window.mansuPractice"),
      new Promise((_, reject) => setTimeout(() => reject(new Error('QA renderer did not respond.')), 10000)),
    ]);
    if (!isolated || requestAllowed({ url: `${PILOT_ORIGIN}/api/sales/prepare`, method: 'POST', resourceType: 'xhr' })) {
      throw new Error('Packaged online pilot sandbox or checkout lock failed.');
    }
    console.log('Packaged online pilot Electron window opened; checkout blocked; no real network request.');
    app.exit(0);
    return;
  }
  await reloadFromService();
  if (!closing) {
    timer = setInterval(async () => {
      try { await verifyPilot(); }
      catch (error) { disconnected(error.message); }
    }, 15000);
    timer.unref();
  }
}

if (single) app.whenReady().then(start).catch(error => {
  if (smoke) { console.error(error); app.exit(1); return; }
  disconnected(error.message);
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { if (timer) clearInterval(timer); });
