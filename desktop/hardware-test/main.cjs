// Separate, deliberately non-selling Electron application. Do not import the
// POS shell, its local ledger, any sync client, or an update provider here.
const { app, BrowserWindow, dialog, session } = require('electron');
const path = require('node:path');

const smoke = process.env.MANSU_HARDWARE_CI_SMOKE === '1' && process.argv.includes('--qa-smoke');
const single = app.requestSingleInstanceLock();
let window;
if (!single) { if (smoke) app.exit(1); else app.quit(); }
else app.on('second-instance', () => {
  if (window && !window.isDestroyed()) {
    if (window.isMinimized()) window.restore();
    window.focus();
  }
});

async function start() {
  // There is no login, Woo catalogue, renderer bridge, payment API, or stock
  // database in this package. The three local assets are the entire UI.
  const assets = new Set(['index.html', 'hardware.css', 'hardware.js']);
  const directory = path.resolve(__dirname);
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    let allowed = false;
    try {
      const url = new URL(details.url);
      // Only the exact bundled files may load. Never send even a test barcode
      // to the network or read an unrelated local file through the renderer.
      if (url.protocol === 'file:' && !url.search && !url.hash) {
        const file = path.resolve(require('node:url').fileURLToPath(url));
        allowed = path.dirname(file) === directory && assets.has(path.basename(file));
      }
    } catch { /* Deny malformed and non-file URLs. */ }
    callback({ cancel: !allowed });
  });
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.on('will-download', event => event.preventDefault());
  window = new BrowserWindow({
    title: 'MansutRENDZGH Hardware Check — TEST ONLY', width: 920, height: 820,
    minWidth: 680, minHeight: 620, backgroundColor: '#f7f2f4', show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false,
      nodeIntegrationInWorker: false, sandbox: true, webSecurity: true, devTools: false },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  await window.loadFile(path.join(directory, 'index.html'));
  if (smoke) {
    const ready = await window.webContents.executeJavaScript(`document.readyState === 'complete' &&
      Boolean(document.querySelector('#scan-code')) &&
      Boolean(document.querySelector('#print-test')) &&
      Boolean(document.querySelector('#print-root .slip'))`);
    if (!ready) throw new Error('Packaged hardware-check window did not load its scanner and print controls.');
    app.exit(0);
    return;
  }
  window.show();
}

if (single) app.whenReady().then(start).catch(error => {
  if (smoke) { console.error(error); app.exit(1); return; }
  dialog.showErrorBox('Hardware check could not start', error.message);
  app.quit();
});
app.on('window-all-closed', () => app.quit());
