import { createHmac, timingSafeEqual } from 'node:crypto';

// Minimal Paystack client for subscriptions in GHS. The secret key stays on
// the platform server; browsers only ever see Paystack's own checkout page.
export class Paystack {
  constructor({ secretKey, fetchImpl = fetch, baseUrl = 'https://api.paystack.co' }) {
    if (!/^sk_(test|live)_[A-Za-z0-9]{20,}$/.test(String(secretKey || ''))) throw new Error('PLATFORM_PAYSTACK_SECRET_KEY must be a Paystack secret key (sk_test_... or sk_live_...).');
    this.secretKey = secretKey;
    this.fetch = fetchImpl;
    this.baseUrl = baseUrl;
    this.testMode = secretKey.startsWith('sk_test_');
  }

  async call(method, path, body) {
    let response;
    try {
      response = await this.fetch(`${this.baseUrl}${path}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(20000),
        headers: { Authorization: `Bearer ${this.secretKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch { throw new Error('Paystack could not be reached. Try again in a moment.'); }
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.status) throw new Error(`Paystack refused the request${data?.message ? `: ${String(data.message).slice(0, 160)}` : ` (HTTP ${response.status})`}.`);
    return data.data;
  }

  initialize({ email, amount, reference, callbackUrl, metadata, plan, channels }) {
    return this.call('POST', '/transaction/initialize', {
      email, amount, currency: 'GHS', reference, callback_url: callbackUrl, metadata,
      ...(plan ? { plan } : {}), ...(channels ? { channels } : {}),
    });
  }

  verify(reference) { return this.call('GET', `/transaction/verify/${encodeURIComponent(reference)}`); }
  manageLink(subscriptionCode) { return this.call('GET', `/subscription/${encodeURIComponent(subscriptionCode)}/manage/link`); }
  createPlan({ name, amount, interval }) { return this.call('POST', '/plan', { name, amount, interval, currency: 'GHS' }); }
}

// Paystack signs each webhook body with HMAC-SHA512 of the secret key.
export function validPaystackSignature(secretKey, rawBody, signature) {
  if (!secretKey || typeof signature !== 'string' || !/^[0-9a-f]{128}$/i.test(signature)) return false;
  const expected = createHmac('sha512', secretKey).update(rawBody).digest();
  const given = Buffer.from(signature, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
