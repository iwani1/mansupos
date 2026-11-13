import { AppError } from '../server/errors.js';

// This is a PROPOSED dedicated hostname, not installed DNS or permission to
// deploy. Pin an exact reviewed origin at build time; a wildcard subdomain,
// the public shop and the existing read-only POS pilot must never receive a
// desktop staff password. Changing the host requires a reviewed new build.
export const TRADING_ORIGIN = 'https://trading.mansutrendzgh.com';
export function tradingOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.port || url.username || url.password || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash ||
      url.origin !== TRADING_ORIGIN) {
    throw new AppError('Use only the separately approved trading.mansutrendzgh.com POS host. The read-only pilot and shop are not trading servers.', 400, 'INVALID_TRADING_HOST');
  }
  return url.origin;
}

export class DesktopRemote {
  constructor(fetchImpl = fetch) { this.fetch = fetchImpl; }
  async request(origin, token, resource, method = 'GET', body) {
    const base = tradingOrigin(origin);
    if (!/^\/((auth\/login)|(desktop\/(enroll|bootstrap|sync|allocate)))(\?deviceId=[0-9a-f-]{36})?$/.test(resource) ||
      (resource.startsWith('/auth/login') && method !== 'POST') ||
      (resource.startsWith('/desktop/bootstrap') && method !== 'GET') ||
      (!resource.startsWith('/desktop/bootstrap') && method !== 'POST')) throw new AppError('Unsupported central POS operation.', 400);
    const url = new URL(`/api${resource}`, base);
    let response;
    try {
      response = await this.fetch(url, {
        method, redirect: 'error', signal: AbortSignal.timeout(20000),
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}`, 'X-Mansu-Session': token } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch { throw new AppError('The trading service could not be reached. Completed local sales remain on this computer.', 503, 'SYNC_OFFLINE'); }
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) throw new AppError('The trading service returned an unexpected page. Do not retry checkout with a new key.', 502, 'INVALID_CENTRAL_RESPONSE');
    const text = await response.text();
    if (text.length > 8_000_000) throw new AppError('The trading service response is too large.', 502);
    let data;
    try { data = JSON.parse(text); } catch { throw new AppError('The trading service sent invalid JSON.', 502); }
    if (!response.ok) throw new AppError(data.error || `Trading service returned HTTP ${response.status}.`, response.status,
      response.status === 409 ? 'SYNC_CONFLICT' : data.code || 'CENTRAL_ERROR');
    return data;
  }
}
