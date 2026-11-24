'use strict';

// Windows till shell for the LIVE online POS. Every sale, stock change and
// cash movement is a synchronous request to ONE pinned HTTPS shop, which
// enforces staff permissions and its own trading gates. There is no local
// ledger, offline sale or later-sync queue, and the app never talks to
// WooCommerce directly.
//
// One installer serves every shop: on first launch the till is pinned to
// https://<shop>.<platformDomain> (or a listed legacy address, e.g. the
// MansutRENDZGH till) and then only ever talks to that shop. Until a shop is
// pinned, every request is refused. No URL/hostname/environment override.
const TILL = require('./till.json');
const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/;
const RESERVED = new Set(['www', 'app', 'api', 'admin', 'console', 'platform', 'mail', 'static', 'cdn', 'status', 'help', 'support', 'docs', 'billing', 'pay', 'login', 'signup']);
let POS_ORIGIN = null;

// Is this exactly a shop origin this till may serve?
function validShopOrigin(value) {
  if (typeof value !== 'string') return false;
  let url;
  try { url = new URL(value); } catch { return false; }
  if (url.protocol !== 'https:' || url.origin !== value || url.port) return false;
  if (TILL.legacyOrigins.includes(value)) return true;
  const suffix = `.${TILL.platformDomain}`;
  if (!url.hostname.endsWith(suffix)) return false;
  const slug = url.hostname.slice(0, -suffix.length);
  return SLUG.test(slug) && !slug.includes('--') && !RESERVED.has(slug);
}

// What a cashier types ("amaboutique", "amaboutique.mansupos.com" or a full
// https:// address) -> the shop's origin, or an error in plain words.
function shopAddress(input) {
  const text = String(input || '').trim().toLowerCase().replace(/\/+$/, '');
  if (!text) throw new Error('Type your shop address, for example amaboutique.');
  let origin;
  if (/^https?:\/\//.test(text)) {
    if (/^http:/.test(text)) throw new Error('Use the https:// address.');
    let url;
    try { url = new URL(text); } catch { throw new Error('That is not a web address.'); }
    if (url.username || url.password || url.search || url.hash) throw new Error('Use only the shop address.');
    if (url.pathname !== '/' && url.pathname !== '') throw new Error('Use only the shop address, without a page path.');
    origin = url.origin;
  } else if (text.includes('.')) origin = `https://${text}`;
  else origin = `https://${text}.${TILL.platformDomain}`;
  if (!validShopOrigin(origin)) throw new Error(`That is not a Mansu POS shop address. It looks like yourshop.${TILL.platformDomain}.`);
  return origin;
}

function pinShop(origin) {
  if (!validShopOrigin(origin)) throw new Error('Not a valid shop address.');
  if (POS_ORIGIN && POS_ORIGIN !== origin) throw new Error('This till is already set up for another shop.');
  POS_ORIGIN = origin;
}
const currentShop = () => POS_ORIGIN;
const API_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
// The offline-till enrolment/allocation/sync routes and the demo sign-in are
// never used by an online till, whatever the server's settings say.
const BLOCKED_API = [/^\/api\/desktop(?:\/|$)/, /^\/api\/auth\/demo$/];

function posRoot(value) {
  if (!POS_ORIGIN) return false;
  try {
    const url = new URL(value);
    return url.origin === POS_ORIGIN && !url.username && !url.password &&
      url.pathname === '/' && !url.search && !url.hash;
  } catch { return false; }
}

// Electron webRequest sees every renderer request, including redirects. The
// POS web app (pages and /api) is allowed; service workers, frames, sockets,
// other sites and the offline-till routes are refused. Product photos come
// only from the store's HTTPS WordPress uploads.
function requestAllowed({ url: value, method, resourceType }) {
  if (!POS_ORIGIN) return false;
  let url;
  try { url = new URL(value); } catch { return false; }
  const verb = String(method || '').toUpperCase();
  // Local previews of a photo being added to a product, and exported files.
  if (url.protocol === 'blob:') return value.startsWith(`blob:${POS_ORIGIN}/`) && verb === 'GET';
  if (url.protocol === 'data:') return verb === 'GET' && resourceType === 'image' && /^data:image\//i.test(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) return false;
  if (resourceType === 'subFrame' || resourceType === 'webSocket' || url.pathname === '/sw.js') return false;
  if (url.origin === POS_ORIGIN) {
    if (resourceType === 'mainFrame') return (verb === 'GET' || verb === 'HEAD') && posRoot(value);
    if (url.pathname.startsWith('/api/')) {
      return resourceType === 'xhr' && API_METHODS.has(verb) && !BLOCKED_API.some(pattern => pattern.test(url.pathname));
    }
    if (verb !== 'GET' && verb !== 'HEAD') return false;
    return url.pathname === '/' || url.pathname === '/favicon.svg' ||
      url.pathname === '/manifest.webmanifest' || url.pathname.startsWith('/icons/') ||
      url.pathname.startsWith('/assets/');
  }
  // Product photos live on each shop's own WordPress store (any HTTPS host),
  // and only as images from its uploads folder.
  return verb === 'GET' && resourceType === 'image' && url.pathname.startsWith('/wp-content/uploads/');
}

// Exports are built in the page (blob:) or fetched from a POS export route.
function downloadAllowed(value) {
  if (typeof value !== 'string' || !POS_ORIGIN) return false;
  if (value.startsWith(`blob:${POS_ORIGIN}/`)) return true;
  try {
    const url = new URL(value);
    return url.origin === POS_ORIGIN && /^\/api\/(?:[a-z-]+\/)*export$/.test(url.pathname);
  } catch { return false; }
}

const SAFE_DOWNLOAD = /\.(?:csv|json|txt|pdf)$/i;
function downloadName(name) {
  const base = [...String(name || '')].map(ch => (ch.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(ch) ? '_' : ch))
    .join('').replace(/^\.+/, '').slice(0, 120);
  return SAFE_DOWNLOAD.test(base) ? base : `${base || 'mansu-pos-export'}.csv`;
}

// Health must come straight from the pinned host as live-mode JSON. A server
// in read-only mode still opens: the POS screens then show their own lock.
async function verifyPos(fetchImpl = fetch, origin = POS_ORIGIN) {
  const HEALTH_URL = `${origin}/api/health`;
  try {
    if (!validShopOrigin(origin)) throw new Error('No shop.');
    const response = await fetchImpl(HEALTH_URL, {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: { Accept: 'application/json', 'Cache-Control': 'no-store' },
    });
    // Electron's net.fetch leaves response.url empty; redirect: 'error' already
    // refuses any redirect, and a non-empty URL must still be the pinned one.
    if (response.status === 404) throw Object.assign(new Error('No shop.'), { noShop: true });
    if (response.status !== 200 || response.redirected || (response.url && response.url !== HEALTH_URL) ||
        !/\bapplication\/json\b/i.test(response.headers.get('content-type') || '')) throw new Error('Invalid health response.');
    const text = await response.text();
    if (text.length > 2048) throw new Error('Unexpected health response size.');
    const health = JSON.parse(text);
    if (health.ok !== true || health.mode !== 'live') throw new Error('Not the live POS.');
    return { readOnly: health.liveReadOnly === true, version: typeof health.version === 'string' ? health.version.slice(0, 32) : '' };
  } catch (error) {
    const host = String(origin || '').replace('https://', '');
    if (error?.noShop) throw new Error(`There is no Mansu POS shop at ${host}. Check the spelling with the shop owner.`, { cause: error });
    throw new Error(`The shop at ${host} could not be reached securely. Check the address and the internet connection.`, { cause: error });
  }
}

// Till settings live in the app's own folder (till-settings.json): the
// receipt printer's name, whether to print after each sale, and the cash
// drawer options (open after cash sales; connector pin 2 or 5). Anything
// unexpected is ignored.
function parseSettings(text) {
  try {
    const value = JSON.parse(String(text || ''));
    const printer = value && typeof value.receiptPrinter === 'string' ? value.receiptPrinter.trim() : '';
    return {
      receiptPrinter: printer && printer.length <= 256 && ![...printer].some(ch => ch.charCodeAt(0) < 32) ? printer : null,
      autoPrint: value?.autoPrint === true,
      drawerOnCash: value?.drawerOnCash === true,
      drawerPin: value?.drawerPin === 5 ? 5 : 2,
      shopOrigin: validShopOrigin(value?.shopOrigin) ? value.shopOrigin : null,
    };
  } catch { return { receiptPrinter: null, autoPrint: false, drawerOnCash: false, drawerPin: 2, shopOrigin: null }; }
}

// Only the POS page in the till window may ask for a silent print.
function printRequestAllowed(frameUrl) {
  if (!POS_ORIGIN) return false;
  try { const url = new URL(frameUrl); return url.origin === POS_ORIGIN && url.pathname === '/'; }
  catch { return false; }
}

// A sale id from the POS (UUID or similar): short, plain characters only.
const validSaleId = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,100}$/.test(value);

// Release notice published by the platform: offered only when newer, and only
// with a download on an allowed HTTPS host. Its SHA-256 is passed on so a
// code-signed till can verify the download before installing (updater.cjs).
function newerRelease(json, currentVersion) {
  const parse = v => (/^(\d{1,4})\.(\d{1,4})\.(\d{1,4})$/.exec(String(v || '')) || []).slice(1).map(Number);
  const next = parse(json?.version), now = parse(currentVersion);
  if (next.length !== 3 || now.length !== 3) return null;
  const newer = next[0] - now[0] || next[1] - now[1] || next[2] - now[2];
  if (newer <= 0) return null;
  let url;
  try { url = new URL(json.url); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || !TILL.downloadHosts.includes(url.hostname)) return null;
  const sha256 = /^[0-9a-f]{64}$/i.test(String(json.sha256 || '')) ? String(json.sha256).toLowerCase() : null;
  return { version: json.version, url: url.toString(), notes: String(json.notes || '').slice(0, 400), ...(sha256 ? { sha256 } : {}) };
}

module.exports = { TILL, validShopOrigin, shopAddress, pinShop, currentShop, newerRelease, posRoot, requestAllowed, downloadAllowed, downloadName, verifyPos, parseSettings, printRequestAllowed, validSaleId };
