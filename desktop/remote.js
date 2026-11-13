import { AppError } from '../server/errors.js';
import { tradingOrigin } from './trading-origin.js';

export { TRADING_ORIGIN, tradingOrigin } from './trading-origin.js';

export class DesktopRemote {
  constructor(fetchImpl = fetch) {
    this.fetch = fetchImpl;
    this.validateOrigin = tradingOrigin;
    this.expectedService = Object.freeze({ mode:'live', storeUrl:'https://www.mansutrendzgh.com' });
  }
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
