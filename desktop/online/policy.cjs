'use strict';

// Windows till shell for the LIVE online POS. Every sale, stock change and
// cash movement is a synchronous request to the pinned HTTPS POS service,
// which enforces staff permissions and its own trading gates. There is no
// local ledger, offline sale or later-sync queue, and the app never talks to
// WooCommerce directly. Do not add a URL/hostname/environment override.
const POS_ORIGIN = 'https://pos.mansutrendzgh.com';
const HEALTH_URL = `${POS_ORIGIN}/api/health`;
const PRODUCT_IMAGE_ORIGINS = new Set([
  'https://mansutrendzgh.com', 'https://www.mansutrendzgh.com',
]);
const API_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
// The offline-till enrolment/allocation/sync routes and the demo sign-in are
// never used by an online till, whatever the server's settings say.
const BLOCKED_API = [/^\/api\/desktop(?:\/|$)/, /^\/api\/auth\/demo$/];

function posRoot(value) {
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
  return verb === 'GET' && resourceType === 'image' &&
    PRODUCT_IMAGE_ORIGINS.has(url.origin) && url.pathname.startsWith('/wp-content/uploads/');
}

// Exports are built in the page (blob:) or fetched from a POS export route.
function downloadAllowed(value) {
  if (typeof value !== 'string') return false;
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
async function verifyPos(fetchImpl = fetch) {
  try {
    const response = await fetchImpl(HEALTH_URL, {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: { Accept: 'application/json', 'Cache-Control': 'no-store' },
    });
    // Electron's net.fetch leaves response.url empty; redirect: 'error' already
    // refuses any redirect, and a non-empty URL must still be the pinned one.
    if (response.status !== 200 || response.redirected || (response.url && response.url !== HEALTH_URL) ||
        !/\bapplication\/json\b/i.test(response.headers.get('content-type') || '')) throw new Error('Invalid health response.');
    const text = await response.text();
    if (text.length > 2048) throw new Error('Unexpected health response size.');
    const health = JSON.parse(text);
    if (health.ok !== true || health.mode !== 'live') throw new Error('Not the live POS.');
    return { readOnly: health.liveReadOnly === true, version: typeof health.version === 'string' ? health.version.slice(0, 32) : '' };
  } catch {
    throw new Error(`The live POS at ${POS_ORIGIN} could not be reached securely.`);
  }
}

module.exports = { POS_ORIGIN, posRoot, requestAllowed, downloadAllowed, downloadName, verifyPos };
