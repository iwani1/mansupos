'use strict';

// This separately installable Windows QA app is pinned to the EXISTING live
// read-only POS pilot. It never contacts the offline trading service or Woo's
// REST API directly. A selling build needs a separate review and approval.
const PILOT_ORIGIN = 'https://pos.mansutrendzgh.com';
const HEALTH_URL = `${PILOT_ORIGIN}/api/health`;
const PRODUCT_IMAGE_ORIGINS = new Set([
  'https://mansutrendzgh.com', 'https://www.mansutrendzgh.com',
]);
const READ_ENDPOINTS = new Set([
  '/api/health', '/api/session', '/api/catalog', '/api/sales',
  '/api/wholesale-prices', '/api/wholesale-buyers',
  '/api/shifts', '/api/shifts/current', '/api/reports', '/api/reports/export',
  '/api/staff', '/api/audit', '/api/connection/diagnostics',
  '/api/instore/catalog', '/api/instore/sales', '/api/instore/reports',
]);
const READ_PATTERNS = [
  /^\/api\/instore\/sales\/(?:by-key\/)?[0-9a-f-]{36}$/i,
  /^\/api\/instore\/stock\/[^/]+\/movements$/,
];
const AUTH_POSTS = new Set(['/api/auth/login', '/api/auth/logout', '/api/auth/password']);

function pilotRoot(value) {
  try {
    const url = new URL(value);
    return url.origin === PILOT_ORIGIN && !url.username && !url.password &&
      url.pathname === '/' && !url.search && !url.hash;
  } catch { return false; }
}

// Electron webRequest sees every renderer request, including redirects. Keep
// HTTPS assets and product photos narrow; prevent service workers, frames,
// downloads and ANY sale/stock/cash/admin write even if the server's gate is
// accidentally changed. Do not allow a URL/hostname/environment override.
function requestAllowed({ url: value, method, resourceType }) {
  let url;
  try { url = new URL(value); } catch { return false; }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) return false;
  const verb = String(method || '').toUpperCase();
  if (resourceType === 'subFrame' || resourceType === 'webSocket' || url.pathname === '/sw.js') return false;
  if (url.origin === PILOT_ORIGIN) {
    if (resourceType === 'mainFrame') return (verb === 'GET' || verb === 'HEAD') && pilotRoot(value);
    if (resourceType === 'xhr' && verb === 'POST' && !url.search) return AUTH_POSTS.has(url.pathname);
    if (verb !== 'GET' && verb !== 'HEAD') return false;
    if (url.pathname.startsWith('/api/')) return resourceType === 'xhr' &&
      (READ_ENDPOINTS.has(url.pathname) || READ_PATTERNS.some(pattern => pattern.test(url.pathname)));
    if (url.pathname === '/' || url.pathname === '/favicon.svg' ||
        url.pathname === '/manifest.webmanifest' || url.pathname.startsWith('/icons/') ||
        url.pathname.startsWith('/assets/')) return true;
    return false;
  }
  return verb === 'GET' && resourceType === 'image' &&
    PRODUCT_IMAGE_ORIGINS.has(url.origin) && url.pathname.startsWith('/wp-content/uploads/');
}

async function verifyPilot(fetchImpl = fetch) {
  try {
    const response = await fetchImpl(HEALTH_URL, {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: { Accept: 'application/json', 'Cache-Control': 'no-store' },
    });
    if (response.status !== 200 || response.redirected || response.url !== HEALTH_URL ||
        !/\bapplication\/json\b/i.test(response.headers.get('content-type') || '')) throw new Error('Invalid health response.');
    const text = await response.text();
    if (text.length > 2048) throw new Error('Unexpected health response size.');
    const health = JSON.parse(text);
    if (health.ok !== true || health.mode !== 'live' || health.liveReadOnly !== true) {
      throw new Error('Pilot read-only gate was not confirmed.');
    }
  } catch {
    throw new Error('The online read-only POS pilot could not be verified over HTTPS. No checkout is available. Check the connection and certificate, then reopen the app.');
  }
}

module.exports = { PILOT_ORIGIN, pilotRoot, requestAllowed, verifyPilot };
