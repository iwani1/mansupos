import { createHash, createHmac } from 'node:crypto';
import { AppError } from './errors.js';

const states = new Set(['claimed', 'created', 'reserved', 'cash_intent', 'payment_started', 'paid', 'cancel_started', 'cancelled', 'needs_review']);
const digest = body => createHash('sha256').update(body).digest('hex');

// Only the Express server holds the dedicated WP Application Password and the
// independent HMAC secret. Never expose either to the browser, URL, audit, or
// logger. HTTP is permitted ONLY to a literal loopback address in NODE_ENV=test.
export class OnlineBridgeClient {
  constructor(config, fetchImpl = fetch) {
    if (!config.onlineBridgeEnabled) throw new Error('The Woo reservation bridge is disabled.');
    this.config = config;
    this.fetch = fetchImpl;
  }
  async request(method, route, payload) {
    if (route !== '/mansu-pos/v1/health' && !/^\/mansu-pos\/v1\/attempts(?:\/[0-9a-f-]{36}(?:\/(?:pay|cancel|cash-intent))?)?$/.test(route)) {
      throw new Error('Unexpected online bridge route.');
    }
    // URL is pinned at configuration time; redirects are forbidden. No URL is
    // supplied by a cashier or from an upstream Woo response.
    const url = new URL(`/wp-json${route}`, this.config.bridgeUrl);
    const body = payload === undefined ? '' : JSON.stringify(payload);
    if (Buffer.byteLength(body) > 16384) throw new AppError('The online bridge request is too large.', 400);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const message = `${timestamp}\n${method}\n${route}\n${digest(body)}`;
    let response;
    try {
      response = await this.fetch(url, {
        method, redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.config.bridgeAppUser}:${this.config.bridgeAppPassword}`).toString('base64')}`,
          'Content-Type': 'application/json', Accept: 'application/json',
          'X-Mansu-Bridge-Timestamp': timestamp,
          'X-Mansu-Bridge-Signature': createHmac('sha256', this.config.bridgeSecret).update(message).digest('hex'),
        },
        ...(payload !== undefined ? { body } : {}),
      });
    } catch {
      throw new AppError('Local Woo bridge request timed out or could not be reached. Check this same attempt; never retry a remote write.', 502, 'BRIDGE_UNCERTAIN');
    }
    let result;
    try {
      const text = await response.text();
      if (text.length > 65536) throw new Error('oversized response');
      result = JSON.parse(text);
    } catch {
      throw new AppError('Local Woo bridge returned an unknown response. Review this attempt.', 502, 'BRIDGE_UNCERTAIN');
    }
    if (!response.ok) {
      // Never surface untrusted WP errors or stack traces to staff/audit logs.
      throw new AppError('Local Woo bridge refused or could not verify the attempt. Inspect its original Woo order and stock hold.', 502, 'BRIDGE_UNCERTAIN');
    }
    if (route === '/mansu-pos/v1/health') {
      if (!result || result.kind !== 'mansu-online-bridge-health' || result.ok !== true ||
          result.service !== this.config.bridgeService || result.siteId !== this.config.bridgeSiteId ||
          !/^[a-f0-9]{8}-[a-f0-9-]{27}$/i.test(result.ledgerId || '') ||
          !/^\\d+\\.\\d+\\.\\d+$/.test(result.wooVersion || '') ||
          result.corePrerequisitesOk !== true || result.cashOnly !== true ||
          typeof result.taxEnabled !== 'boolean' || typeof result.hposEnabled !== 'boolean') {
        throw new AppError('Woo bridge health identity or prerequisites could not be verified.', 502, 'BRIDGE_UNCERTAIN');
      }
      return result; // Signed GET, never an order/stock/cash write.
    }
    if (!result || typeof result !== 'object' || Array.isArray(result) ||
        result.service !== this.config.bridgeService || result.siteId !== this.config.bridgeSiteId ||
        !states.has(result.state) || typeof result.key !== 'string' ||
        typeof result.fingerprint !== 'string' || typeof result.ledgerId !== 'string' ||
        (result.orderId !== null && (!Number.isSafeInteger(result.orderId) || result.orderId < 1)) ||
        !Number.isSafeInteger(result.totalCents) || result.totalCents < 0 ||
        !Number.isSafeInteger(result.taxCents) || result.taxCents < 0 ||
        typeof result.reservationVerified !== 'boolean' || typeof result.cashIntentVerified !== 'boolean' ||
        typeof result.paymentVerified !== 'boolean' || typeof result.cancelledVerified !== 'boolean' ||
        typeof result.orderIdentityVerified !== 'boolean' || typeof result.stockOrCashIntentObserved !== 'boolean' ||
        !Number.isSafeInteger(result.refundedCents) || result.refundedCents < 0 ||
        (result.paidAt !== null && (typeof result.paidAt !== 'string' || !Number.isFinite(Date.parse(result.paidAt)))) ||
        !Array.isArray(result.items) || result.items.length > 100 ||
        (result.expiresAt !== null && (typeof result.expiresAt !== 'string' || !Number.isFinite(Date.parse(result.expiresAt))))) {
      throw new AppError('Local Woo bridge identity or reservation response is incomplete.', 502, 'BRIDGE_UNCERTAIN');
    }
    return result;
  }
  health() { return this.request('GET', '/mansu-pos/v1/health'); }
  create(body) { return this.request('POST', '/mansu-pos/v1/attempts', body); }
  status(key) { return this.request('GET', `/mansu-pos/v1/attempts/${key}`); }
  cashIntent(key) { return this.request('POST', `/mansu-pos/v1/attempts/${key}/cash-intent`, {}); }
  pay(key) { return this.request('POST', `/mansu-pos/v1/attempts/${key}/pay`, {}); }
  cancel(key) { return this.request('POST', `/mansu-pos/v1/attempts/${key}/cancel`, {}); }
}
