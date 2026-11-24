'use strict';

// Mansu POS for Windows: a native till window for ONE online shop, chosen
// once on first launch (picker.html) and then the only site it ever opens.
// Unlike desktop/main.js (the superseded offline till) this app has no SQLite,
// stock allocation, offline sale, sync queue or update feed. The pinned HTTPS
// POS service is the only place a sale, stock change or cash movement happens,
// and it enforces staff permissions and its own trading gates.
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, dialog, ipcMain, Menu, net, session, shell } = require('electron');
const { openDrawer } = require('./drawer.cjs');
const { TILL, shopAddress, pinShop, currentShop, newerRelease, posRoot, requestAllowed, downloadAllowed, downloadName,
  verifyPos: verifyWith, parseSettings, printRequestAllowed, validSaleId } = require('./policy.cjs');

// Chromium's network stack: honours the Windows proxy settings and the
// Windows certificate store, exactly like the till window itself.
const netFetch = (url, options) => net.fetch(url, options);
const verifyPos = () => verifyWith(netFetch, currentShop());

const APP_NAME = 'Mansu POS';
const smoke = process.env.MANSU_ONLINE_CI_SMOKE === '1' && process.argv.includes('--qa-smoke');
// Persistent so held carts and screen preferences survive a restart, like the
// browser. HTTP caching stays off and the service worker is refused, so no
// stale catalogue or offline copy of the POS is ever shown.
const partition = 'persist:mansu-pos-till';
const CHECK_EVERY_MS = 15000;
const BANNER_ID = 'mansu-till-connection-banner';
let window, timer, quitting = false, online = true, serverInfo = { readOnly: false, version: '' };
let settings = { receiptPrinter: null, autoPrint: false, drawerOnCash: false, drawerPin: 2, shopOrigin: null }, printing = false, drawerBusy = false;
let picker = null, hadSettings = false;
const handledSales = []; // recent sale ids, so a receipt prints / the drawer opens automatically only once

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
  const name = currentShop() ? `${APP_NAME} — ${new URL(currentShop()).host}` : APP_NAME;
  if (!online) return `${name} — CONNECTION LOST · do not take payment`;
  return serverInfo.readOnly ? `${name} — read-only (sales switched off)` : name;
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
  await window.loadURL(`${currentShop()}/`).catch(() => { /* did-fail-load handles it */ });
}

// ---- Receipt printer -------------------------------------------------------
// With a receipt printer chosen, "Print receipt" prints straight to it with no
// dialog. Without one, or if it is missing or fails, the normal Windows print
// dialog is offered instead, so a receipt can always be printed.
const settingsFile = () => path.join(app.getPath('userData'), 'till-settings.json');
function loadSettings() {
  try { settings = parseSettings(fs.readFileSync(settingsFile(), 'utf8')); }
  catch { settings = parseSettings(''); }
}
function saveSettings() {
  try { fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2)); }
  catch (error) { dialog.showErrorBox(APP_NAME, `The printer choice could not be saved: ${error.message}`); }
}

const printWith = (contents, options) => new Promise(resolve => {
  contents.print(options, (success, reason) => resolve({ success, reason }));
});

async function printerExists(contents, name) {
  const printers = await contents.getPrintersAsync();
  return printers.some(printer => printer.name === name);
}

async function offerDialogPrint(contents, problem) {
  const { response } = await dialog.showMessageBox(window, {
    type: 'warning', title: APP_NAME, buttons: ['Print with dialog', 'Cancel'], defaultId: 0, cancelId: 1, noLink: true,
    message: 'The receipt did not print', detail: `${problem}\n\nCheck the printer is on, has paper and is connected, or choose another one under Receipt printer.`,
  });
  if (response === 0) await printWith(contents, { silent: false });
}

async function printReceipt(contents) {
  if (printing) return { printed: false, reason: 'busy' };
  printing = true;
  try {
    const name = settings.receiptPrinter;
    if (!name) {
      const { success } = await printWith(contents, { silent: false });
      return { printed: success, silent: false };
    }
    if (!(await printerExists(contents, name))) {
      await offerDialogPrint(contents, `The receipt printer "${name}" is not installed on this computer.`);
      return { printed: false, reason: 'missing' };
    }
    const { success, reason } = await printWith(contents, { silent: true, deviceName: name, printBackground: false });
    if (!success) await offerDialogPrint(contents, `"${name}" reported: ${reason || 'printing failed'}.`);
    return { printed: success, silent: true };
  } finally { printing = false; }
}

// ---- Cash drawer -----------------------------------------------------------
// The drawer is wired to the receipt printer's drawer port; drawer.cjs sends
// it the ESC/POS pulse. Every opening is written to drawer-log.txt.
const drawerLogFile = () => path.join(app.getPath('userData'), 'drawer-log.txt');
function logDrawer(reason, outcome) {
  const line = `${new Date().toISOString()}\t${reason}\t${settings.receiptPrinter || '-'}\tpin ${settings.drawerPin}\t${outcome}\n`;
  try {
    fs.appendFileSync(drawerLogFile(), line);
    if (fs.statSync(drawerLogFile()).size > 512 * 1024) {
      const keep = fs.readFileSync(drawerLogFile(), 'utf8').split('\n').slice(-2000).join('\n');
      fs.writeFileSync(drawerLogFile(), keep);
    }
  } catch { /* logging must never stop the drawer */ }
}

async function openCashDrawer(reason) {
  if (!settings.receiptPrinter) {
    dialog.showMessageBox(window, { type: 'info', title: 'Cash drawer', message: 'Choose the receipt printer first',
      detail: 'The cash drawer opens through the receipt printer it is plugged into. Use Receipt printer → Choose receipt printer…' });
    return false;
  }
  if (drawerBusy) return false;
  drawerBusy = true;
  try {
    await openDrawer(settings.receiptPrinter, settings.drawerPin);
    logDrawer(reason, 'opened');
    return true;
  } catch (error) {
    logDrawer(reason, `FAILED: ${error.message}`);
    dialog.showMessageBox(window, { type: 'warning', title: 'Cash drawer', message: 'The cash drawer did not open',
      detail: `${error.message}\n\nCheck the drawer cable is in the printer's drawer port (not the computer) and the printer is on. ` +
        'If the drawer still does not open, try the other connector under Cash drawer (pin 2 / pin 5).' });
    return false;
  } finally { drawerBusy = false; }
}

async function openDrawerNow() {
  const { response } = await dialog.showMessageBox(window, {
    type: 'question', title: 'Cash drawer', buttons: ['Open drawer', 'Cancel'], defaultId: 0, cancelId: 1, noLink: true,
    message: 'Open the cash drawer?', detail: 'Use this for giving change or a cash count. Each opening is recorded in the drawer log on this PC.',
  });
  if (response === 0) await openCashDrawer('opened from menu');
}

function showDrawerLog() {
  let lines = [];
  try { lines = fs.readFileSync(drawerLogFile(), 'utf8').trim().split('\n').filter(Boolean).slice(-25).reverse(); } catch { /* none yet */ }
  dialog.showMessageBox(window, { type: 'info', title: 'Cash drawer log', message: 'Last drawer openings on this PC (newest first)',
    detail: lines.length ? lines.map(line => line.split('\t').slice(0, 2).concat(line.split('\t').slice(4)).join('  ·  ')).join('\n') +
      `\n\nFull log: ${drawerLogFile()}` : 'No drawer openings yet.' });
}

function setDrawer(change) {
  Object.assign(settings, change);
  saveSettings();
  buildMenu();
}

// A just-paid sale's receipt is on screen. Once per sale: open the drawer for
// a cash sale (if switched on) and print silently (if auto-print is on). Never
// opens the print dialog by itself; failures show the usual warnings.
async function receiptReady(contents, saleId, cash) {
  if (!settings.receiptPrinter || !validSaleId(saleId)) return { printed: false };
  if (handledSales.includes(saleId)) return { printed: false, reason: 'already handled' };
  handledSales.push(saleId);
  if (handledSales.length > 50) handledSales.shift();
  if (cash === true && settings.drawerOnCash) openCashDrawer(`cash sale ${saleId}`);
  return settings.autoPrint ? printReceipt(contents) : { printed: false };
}

function setAutoPrint(enabled) {
  settings.autoPrint = Boolean(enabled);
  saveSettings();
  buildMenu();
}

async function chooseReceiptPrinter() {
  const printers = (await window.webContents.getPrintersAsync()).slice(0, 12);
  const names = printers.map(printer => printer.name);
  const buttons = [...printers.map(printer => printer.displayName || printer.name), 'Ask each time (print dialog)', 'Cancel'];
  const { response } = await dialog.showMessageBox(window, {
    type: 'question', title: 'Receipt printer', buttons, cancelId: buttons.length - 1, noLink: true,
    message: 'Which printer should receipts go to?',
    detail: `Now: ${settings.receiptPrinter || 'ask each time'}.\n\nReceipts will print straight to the chosen printer with no dialog. ` +
      'Match the paper width on the receipt screen (80 mm, 58 mm or A4) to the printer.' +
      (printers.length ? '' : '\n\nNo printers are installed. Install the printer driver in Windows first.'),
  });
  if (response === buttons.length - 1) return;
  settings.receiptPrinter = response < names.length ? names[response] : null;
  saveSettings();
  buildMenu();
  if (settings.receiptPrinter) {
    const { response: test } = await dialog.showMessageBox(window, {
      type: 'info', title: 'Receipt printer', buttons: ['Print a test receipt', 'Not now'], defaultId: 0, cancelId: 1, noLink: true,
      message: `Receipts will print to "${settings.receiptPrinter}".`,
    });
    if (test === 0) await printTestReceipt();
  }
}

const testReceiptHtml = () => `<!doctype html><meta charset="utf-8"><style>
@page{margin:3mm}body{margin:0;font:11px/1.4 monospace;color:#000;width:72mm}h1{font-size:14px;margin:0 0 4px;text-align:center}
p{margin:2px 0}hr{border:0;border-top:1px dashed #000;margin:6px 0}.c{text-align:center}</style>
<h1>MANSUTRENDZGH</h1><p class="c">Mansu POS for Windows</p><hr><p>TEST PRINT — NOT A RECEIPT</p>
<p>Printer: ${String(settings.receiptPrinter).replace(/[<>&]/g, '')}</p><p>${new Date().toLocaleString('en-GB')}</p><hr>
<p>1234567890123456789012345678901234567890</p><p class="c">If this line is centred and not cut off, the printer is ready.</p>`;

async function printTestReceipt() {
  if (!settings.receiptPrinter) { await chooseReceiptPrinter(); return; }
  const page = new BrowserWindow({ show: false, webPreferences: { sandbox: true, javascript: false, contextIsolation: true } });
  try {
    await page.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(testReceiptHtml())}`);
    if (!(await printerExists(page.webContents, settings.receiptPrinter))) {
      dialog.showErrorBox('Receipt printer', `"${settings.receiptPrinter}" is not installed on this computer. Choose another printer.`);
      return;
    }
    const { success, reason } = await printWith(page.webContents, { silent: true, deviceName: settings.receiptPrinter, printBackground: false });
    if (!success) dialog.showErrorBox('Receipt printer', `The test did not print: ${reason || 'printing failed'}.`);
  } finally { page.destroy(); }
}

function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'POS', submenu: [
      { label: 'Reload', accelerator: 'Ctrl+R', click: () => loadPos() },
      { label: 'Change shop…', click: changeShop },
      { type: 'separator' },
      { role: 'togglefullscreen', label: 'Full screen', accelerator: 'F11' },
      { role: 'zoomIn', label: 'Larger text', accelerator: 'Ctrl+=' },
      { role: 'zoomOut', label: 'Smaller text', accelerator: 'Ctrl+-' },
      { role: 'resetZoom', label: 'Normal text size', accelerator: 'Ctrl+0' },
      { type: 'separator' }, { role: 'quit', label: 'Close' },
    ] },
    { label: 'Receipt printer', submenu: [
      { label: settings.receiptPrinter ? `Printing to: ${settings.receiptPrinter}` : 'Not chosen: print dialog each time', enabled: false },
      { type: 'separator' },
      { label: 'Choose receipt printer…', click: chooseReceiptPrinter },
      { label: 'Print a test receipt', enabled: Boolean(settings.receiptPrinter), click: printTestReceipt },
      { type: 'separator' },
      { label: 'Print automatically after each sale', type: 'checkbox', checked: Boolean(settings.autoPrint && settings.receiptPrinter),
        enabled: Boolean(settings.receiptPrinter), click: item => setAutoPrint(item.checked) },
    ] },
    { label: 'Cash drawer', submenu: [
      { label: 'Open cash drawer now…', accelerator: 'Ctrl+Shift+D', enabled: Boolean(settings.receiptPrinter), click: openDrawerNow },
      { type: 'separator' },
      { label: 'Open after each cash sale', type: 'checkbox', checked: Boolean(settings.drawerOnCash && settings.receiptPrinter),
        enabled: Boolean(settings.receiptPrinter), click: item => setDrawer({ drawerOnCash: item.checked }) },
      { type: 'separator' },
      { label: 'Drawer cable on pin 2 (most drawers)', type: 'radio', checked: settings.drawerPin !== 5, click: () => setDrawer({ drawerPin: 2 }) },
      { label: 'Drawer cable on pin 5', type: 'radio', checked: settings.drawerPin === 5, click: () => setDrawer({ drawerPin: 5 }) },
      { type: 'separator' },
      { label: 'Show drawer log', click: showDrawerLog },
    ] },
    { label: 'Help', submenu: [{ label: 'Check for updates', click: () => checkForUpdate(true) }, { label: `About ${APP_NAME}`, click: about }] },
  ]));
}

function about() {
  dialog.showMessageBox(window, {
    type: 'info', title: APP_NAME, message: `${APP_NAME} for Windows ${app.getVersion()}`,
    detail: `Connected to ${currentShop()}${serverInfo.version ? ` (POS ${serverInfo.version})` : ''}.\n\n` +
      'Every sale is recorded on the online POS and the website at the moment it is made. ' +
      'Nothing is stored for later: if the connection drops, wait for it to come back before taking payment.',
  });
}

async function startTill() {
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
      partition, preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false,
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

  buildMenu();
  // The page's only bridge (preload.cjs). Accept it only from the POS page in
  // the till window, never from another frame or window.
  const fromPos = event => Boolean(window && !window.isDestroyed() && event.sender === window.webContents &&
    event.senderFrame === window.webContents.mainFrame && printRequestAllowed(event.senderFrame.url));
  ipcMain.handle('mansu-till:print-receipt', event => (fromPos(event) ? printReceipt(window.webContents) : { printed: false, reason: 'refused' }));
  ipcMain.handle('mansu-till:receipt-ready', (event, saleId, cash) => (fromPos(event) ? receiptReady(window.webContents, saleId, cash === true) : { printed: false, reason: 'refused' }));

  if (smoke) {
    // Packaged Windows runner checks the real Electron window and request
    // policy without contacting the POS or entering credentials.
    await Promise.race([
      window.loadURL('about:blank'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('QA blank window did not load.')), 10000)),
    ]);
    const isolated = await Promise.race([
      window.webContents.executeJavaScript(
        "document.readyState === 'complete' && typeof require === 'undefined' && !window.mansuDesktop && !window.mansuPractice && " +
        "Object.keys(window.mansuTill || {}).sort().join() === 'printReceipt,receiptReady' && typeof window.mansuTill.printReceipt === 'function'"),
      new Promise((_, reject) => setTimeout(() => reject(new Error('QA renderer did not respond.')), 10000)),
    ]);
    const shop = currentShop();
    const sells = requestAllowed({ url: `${shop}/api/sales/prepare`, method: 'POST', resourceType: 'xhr' });
    const offlineSync = requestAllowed({ url: `${shop}/api/desktop/sync`, method: 'POST', resourceType: 'xhr' });
    const otherSite = requestAllowed({ url: 'https://example.com/', method: 'GET', resourceType: 'mainFrame' });
    const otherShop = requestAllowed({ url: `https://othershop.${TILL.platformDomain}/api/sales`, method: 'GET', resourceType: 'xhr' });
    // The first-launch picker renders with only its two-function bridge.
    await openPicker({ hidden: true });
    const pickerOk = await picker.webContents.executeJavaScript(
      "typeof require === 'undefined' && Object.keys(window.mansuTillSetup || {}).sort().join() === 'choose,info' && Boolean(document.getElementById('address'))");
    if (!isolated || !sells || offlineSync || otherSite || otherShop || !pickerOk) throw new Error('Packaged till sandbox, picker or request policy failed.');
    console.log('Packaged Mansu POS window opened sandboxed with only the receipt-print bridge; shop picker renders; pinned shop allowed, other shops, offline sync and other sites blocked; no real network request.');
    app.exit(0);
    return;
  }

  await loadPos();
  timer = setInterval(checkConnection, CHECK_EVERY_MS);
  timer.unref();
  setTimeout(() => checkForUpdate(false), 30000).unref();
  setInterval(() => checkForUpdate(false), 12 * 3600000).unref();
}

// ---- Choosing the shop -----------------------------------------------------
// First launch (or after "Change shop"): a small local page asks for the shop
// address; the main process checks it is a live Mansu POS shop, saves it and
// pins it. From then on the till opens only that shop.
function openPicker({ hidden = false } = {}) {
  picker = new BrowserWindow({
    title: `${APP_NAME} — choose your shop`, width: 560, height: 620, resizable: false, show: false, backgroundColor: '#f6f3ef',
    webPreferences: { preload: path.join(__dirname, 'picker-preload.cjs'), contextIsolation: true, nodeIntegration: false,
      sandbox: true, webSecurity: true, webviewTag: false, devTools: !app.isPackaged, spellcheck: false },
  });
  picker.removeMenu();
  picker.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  picker.webContents.on('will-navigate', event => event.preventDefault());
  if (!hidden) picker.once('ready-to-show', () => picker?.show());
  return picker.loadFile(path.join(__dirname, 'picker.html'));
}

function registerPickerBridge() {
  const fromPicker = event => Boolean(picker && !picker.isDestroyed() && event.sender === picker.webContents);
  ipcMain.handle('till-setup:info', event => (fromPicker(event) ? {
    platformDomain: TILL.platformDomain,
    // A till upgraded from the MansutRENDZGH-only version suggests its old address.
    suggestion: hadSettings && TILL.legacyOrigins[0] ? new URL(TILL.legacyOrigins[0]).host : '',
  } : null));
  ipcMain.handle('till-setup:choose', async (event, address) => {
    if (!fromPicker(event)) return { ok: false, error: 'Refused.' };
    let origin;
    try { origin = shopAddress(address); } catch (error) { return { ok: false, error: error.message }; }
    try { serverInfo = await verifyWith(netFetch, origin); } catch (error) { return { ok: false, error: error.message }; }
    settings.shopOrigin = origin;
    saveSettings();
    pinShop(origin);
    const chooser = picker;
    picker = null;
    await startTill();
    chooser.close();
    return { ok: true };
  });
}

// Only the shop's owner, signed in on this till, may point it at another shop.
async function changeShop() {
  let role;
  try {
    role = await window.webContents.executeJavaScript(
      "fetch('/api/session', { credentials: 'same-origin', cache: 'no-store' }).then(r => r.json()).then(d => (d && d.user && d.user.role) || null)", true);
  } catch { role = null; }
  if (role !== 'owner') {
    await dialog.showMessageBox(window, { type: 'info', title: 'Change shop', message: 'Only the shop owner can change the shop on this till',
      detail: 'Sign in on this till as the owner, then choose POS → Change shop again.' });
    return;
  }
  const host = new URL(currentShop()).host;
  const { response } = await dialog.showMessageBox(window, {
    type: 'warning', title: 'Change shop', buttons: ['Disconnect this till', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true,
    message: `Disconnect this till from ${host}?`,
    detail: 'Everyone is signed out and held sales on this till are cleared. Printer and cash drawer settings stay. The till restarts and asks for the new shop address.',
  });
  if (response !== 0) return;
  await session.fromPartition(partition).clearStorageData();
  settings.shopOrigin = null;
  saveSettings();
  app.relaunch();
  app.exit(0);
}

// ---- Updates ---------------------------------------------------------------
// Until releases are code-signed the till never installs anything by itself:
// it tells staff a new version exists and opens the download on an allowed host.
async function checkForUpdate(manual) {
  try {
    const response = await net.fetch(TILL.updateFeed, { redirect: 'error', signal: AbortSignal.timeout(10000), headers: { Accept: 'application/json' } });
    const release = newerRelease(await response.json(), app.getVersion());
    if (!release) {
      if (manual) dialog.showMessageBox(window, { type: 'info', title: APP_NAME, message: `You have the latest version (${app.getVersion()}).` });
      return;
    }
    const { response: choice } = await dialog.showMessageBox(window, {
      type: 'info', title: APP_NAME, buttons: ['Download', 'Later'], defaultId: 0, cancelId: 1, noLink: true,
      message: `${APP_NAME} ${release.version} is available`,
      detail: `You have ${app.getVersion()}.${release.notes ? `\n\n${release.notes}` : ''}\n\nDownload it, then install it when the shop is closed. Your shop, printer and drawer settings are kept.`,
    });
    if (choice === 0) await shell.openExternal(release.url);
  } catch {
    if (manual) dialog.showMessageBox(window, { type: 'warning', title: APP_NAME, message: 'Could not check for updates', detail: 'Check the internet connection and try again.' });
  }
}

async function start() {
  hadSettings = fs.existsSync(settingsFile());
  loadSettings();
  registerPickerBridge();
  if (smoke) { pinShop(`https://smoketest.${TILL.platformDomain}`); return startTill(); }
  if (settings.shopOrigin) { pinShop(settings.shopOrigin); return startTill(); }
  return openPicker();
}

if (single) app.whenReady().then(start).catch(error => {
  if (smoke) { console.error(error); app.exit(1); return; }
  dialog.showErrorBox(APP_NAME, error.message);
  app.quit();
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { quitting = true; if (timer) clearInterval(timer); });
