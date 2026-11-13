import { AppError } from './errors.js';

// The dedicated WordPress Application Password stays on the CENTRAL server.
// Never put it in the desktop installer, a renderer, Woo product metadata, or
// the existing read-only pilot. WordPress checks manage_woocommerce on routes.
export class OfflineReservations {
  constructor(config, fetchImpl = fetch) { this.config = config; this.fetch = fetchImpl; }
  async request(route, method = 'GET', body) {
    if (!this.config.desktopSetupEnabled || this.config.liveReadOnly || !this.config.writesEnabled) {
      throw new AppError('Offline reservations are locked on this trading service.', 403, 'OFFLINE_RESERVATIONS_LOCKED');
    }
    const url = new URL(`${this.config.storeUrl}/wp-json/mansu-pos/v1/${route}`);
    let response;
    try {
      response = await this.fetch(url, { method, redirect: 'error', signal: AbortSignal.timeout(20000),
        headers: { Authorization: `Basic ${Buffer.from(`${this.config.desktopAppUser}:${this.config.desktopAppPassword}`).toString('base64')}`,
          'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'MansuPOS-offline/1.2.3' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch { throw new AppError('Woo reservation service could not be reached. Keep local sales pending; do not reallocate stock.', 503, 'RESERVATION_UNCERTAIN'); }
    const content = await response.text();
    let result;
    try { result = JSON.parse(content); } catch { throw new AppError('Woo reservation service returned an unexpected response. Review it before retrying.', 502, 'RESERVATION_UNCERTAIN'); }
    if (!response.ok) throw new AppError(result.message || 'Woo reservation request needs owner review.', response.status >= 500 ? 503 : response.status,
      response.status === 409 ? 'RESERVATION_CONFLICT' : 'RESERVATION_UNCERTAIN');
    return result;
  }
  status(deviceId) { return this.request(`status?device_id=${encodeURIComponent(deviceId)}`); }
  allocate(input) { return this.request('allocate', 'POST', input); }
  sync(event) { return this.request('sync', 'POST', event); }
}
