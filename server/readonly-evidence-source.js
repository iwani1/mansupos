/**
 * Phase 3.0: synthetic-only read adapter for the future Woo/Paystack evidence
 * integration. This module is intentionally NOT wired into app.js, routes,
 * config flags or the live read-only catalogue pilot. It cannot access a
 * merchant account and its outputs never authorize a financial operation.
 *
 * No arbitrary URLs, no POST, no redirects, no credentials from browser data.
 * Even successful credentialed HTTP reads cannot prove bank credit or payouts.
 */
import { compareSettlementEvidence } from './settlement-evidence-comparison.js';

const WOO_ORIGIN = 'https://shop.mansu-pos-evidence.invalid';
const PAYSTACK_ORIGIN = 'https://api.paystack.co';
const MAX_JSON_BYTES = 65536;
const MAX_REFUNDS = 100;
const syntheticKey = 'ck_synthetic_evidence_only';
const syntheticSecret = 'cs_synthetic_evidence_only';
const syntheticPaystackSecret = 'sk_test_synthetic_evidence_only';

function refusal() {
  // Do not interpolate an upstream response, URL, reference or credential.
  return new Error('Synthetic read-only evidence source rejected; no financial state was changed.');
}
function moneyCents(raw, { refund = false } = {}) {
  if (typeof raw !== 'string' || !/^-?[0-9]{1,12}(?:\.[0-9]{1,2})?$/.test(raw)) throw refusal();
  const negative = raw.startsWith('-');
  if (negative && !refund) throw refusal();
  const value = negative ? raw.slice(1) : raw;
  const [major, fraction = ''] = value.split('.');
  const cents = Number(major) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents) || cents <= 0) throw refusal();
  return cents;
}
function referenceFromWoo(order) {
  if (!Array.isArray(order.meta_data)) throw refusal();
  const refs = order.meta_data.filter(x => x?.key === '_paystack_txn_ref');
  if (refs.length !== 1 || typeof refs[0].value !== 'string' ||
      !/^[A-Za-z0-9_.-]{8,256}$/.test(refs[0].value)) throw refusal();
  return refs[0].value;
}
function normalizeOriginal(order, id) {
  if (!order || !Number.isSafeInteger(order.id) || order.id !== id ||
      order.currency !== 'GHS' || order.payment_method !== 'paystack' ||
      !['pending','on-hold','processing','completed','refunded','cancelled','failed'].includes(order.status) ||
      typeof order.date_modified_gmt !== 'string' ||
      !order.date_modified_gmt || order.date_modified_gmt.length > 40) throw refusal();
  const base = {
    orderId: order.id, totalCents: moneyCents(order.total),
    status: order.status, paymentMethod: order.payment_method,
    currency: order.currency, originalReference: referenceFromWoo(order),
    modified: order.date_modified_gmt,
    refundIds: Array.isArray(order.refunds) ?
      order.refunds.map(x => x?.id).sort((a,b) => a-b) : null,
  };
  if (base.refundIds !== null && base.refundIds.some(x => !Number.isSafeInteger(x) || x < 1)) throw refusal();
  return base;
}
function requireSameOriginal(first, second) {
  if (JSON.stringify(first) !== JSON.stringify(second)) {
    throw new Error('Synthetic Woo order changed during evidence collection; manual reconciliation required.');
  }
}

export class SyntheticReadOnlyEvidenceReader {
  constructor({ env, wooOrigin, wooKey, wooSecret, paystackSecret, fetchImpl }) {
    if (env?.NODE_ENV !== 'test' || env?.MANSU_CI_SYNTHETIC_EVIDENCE !== 'true' ||
        wooOrigin !== WOO_ORIGIN || wooKey !== syntheticKey ||
        wooSecret !== syntheticSecret || paystackSecret !== syntheticPaystackSecret ||
        typeof fetchImpl !== 'function' || fetchImpl === globalThis.fetch) {
      throw new Error('Merchant-site evidence readers are NOT enabled; use injected synthetic test HTTP only.');
    }
    this.fetch = fetchImpl;
    this.wooAuthorization = 'Basic ' + Buffer.from(wooKey + ':' + wooSecret).toString('base64');
    this.paystackAuthorization = 'Bearer ' + paystackSecret;
  }
  async getJSON(url, auth, expectedKind) {
    const target = new URL(url);
    const isWoo = target.origin === WOO_ORIGIN &&
      /^\/wp-json\/wc\/v3\/orders\/[1-9][0-9]*(?:\/refunds)?$/.test(target.pathname) &&
      (target.search === '' || target.search === '?page=1&per_page=100');
    const isPaystack = target.origin === PAYSTACK_ORIGIN &&
      /^\/transaction\/verify\/[A-Za-z0-9_.-]{8,256}$/.test(target.pathname) &&
      target.search === '';
    if (target.username || target.password || target.hash ||
        !(expectedKind === 'woo' ? isWoo : isPaystack)) throw refusal();
    let response;
    try {
      response = await this.fetch(target.href, {
        method: 'GET', redirect: 'error', cache: 'no-store',
        headers: { Authorization: auth, Accept: 'application/json',
          'User-Agent': 'MansuPOS-SyntheticEvidence/1.0' },
        signal: AbortSignal.timeout(5000),
      });
    } catch { throw refusal(); }
    if (!response || response.status !== 200 || response.redirected === true ||
        !/^application\/(?:[a-z0-9.+-]*\+)?json(?:;|$)/i.test(response.headers?.get('content-type') || '')) {
      throw refusal();
    }
    if (response.url && response.url !== target.href) throw refusal();
    const len = Number(response.headers?.get('content-length'));
    if (Number.isFinite(len) && len > MAX_JSON_BYTES) throw refusal();
    let data;
    try {
      const body = await response.text();
      if (Buffer.byteLength(body) > MAX_JSON_BYTES) throw refusal();
      data = JSON.parse(body);
    } catch { throw refusal(); }
    if (!data || typeof data !== 'object') throw refusal();
    return { data, headers: response.headers };
  }

  async inspect(orderId) {
    if (!Number.isSafeInteger(orderId) || orderId < 1 || orderId > 999999999999) throw refusal();
    const base = WOO_ORIGIN + '/wp-json/wc/v3/orders/' + orderId;
    const initial = await this.getJSON(base, this.wooAuthorization, 'woo');
    const first = normalizeOriginal(initial.data, orderId);
    const refunds = await this.getJSON(base + '/refunds?page=1&per_page=100',
      this.wooAuthorization, 'woo');
    const total = Number(refunds.headers.get('x-wp-total'));
    const pages = Number(refunds.headers.get('x-wp-totalpages'));
    if (!Array.isArray(refunds.data) ||
        !Number.isSafeInteger(total) || total < 0 || total > MAX_REFUNDS ||
        pages !== 1 || refunds.data.length !== total ||
        !Number.isSafeInteger(pages)) throw refusal();
    const ids = new Set();
    let refundedCents = 0;
    for (const row of refunds.data) {
      if (!Number.isSafeInteger(row?.id) || row.id < 1 || ids.has(row.id)) throw refusal();
      ids.add(row.id);
      refundedCents += moneyCents(row.amount, { refund: true });
      if (!Number.isSafeInteger(refundedCents) || refundedCents > first.totalCents) throw refusal();
    }
    // Woo's order-level refund IDs must cover exactly the records read. If
    // Woo omitted that list, there's no independent proof of completeness.
    if (first.refundIds === null ||
        JSON.stringify(first.refundIds) !== JSON.stringify([...ids].sort((a,b) => a-b))) throw refusal();
    const gateway = await this.getJSON(PAYSTACK_ORIGIN + '/transaction/verify/' +
      encodeURIComponent(first.originalReference), this.paystackAuthorization, 'paystack');
    const g = gateway.data;
    if (g.status !== true || !g.data || !Number.isSafeInteger(g.data.id) ||
        !Number.isSafeInteger(g.data.amount) || g.data.amount < 1 ||
        typeof g.data.reference !== 'string' || !/^[A-Za-z0-9_.-]{8,256}$/.test(g.data.reference) ||
        g.data.currency !== 'GHS' || typeof g.data.status !== 'string' ||
        g.data.status.length > 40) throw refusal();
    const recheck = await this.getJSON(base, this.wooAuthorization, 'woo');
    requireSameOriginal(first, normalizeOriginal(recheck.data, orderId));
    const comparison = compareSettlementEvidence({
      woo: { orderId, totalCents: first.totalCents, refundedCents,
        currency: first.currency, status: first.status,
        paymentMethod: first.paymentMethod, originalReference: first.originalReference },
      gateway: { transactionId: g.data.id, reference: g.data.reference,
        amountCents: g.data.amount, status: g.data.status, currency: g.data.currency },
      settlement: null, gatewayRefunds: null, relatedWooOrders: [],
    });
    return {
      kind: 'synthetic-woo-paystack-read-contract',
      disconnectedFromMerchant: true,
      merchantSourceAuthenticated: false,
      websiteOrdersGloballyScanned: false,
      gatewayRefundHistoryComplete: false,
      independentSettlementAvailable: false,
      financialOperationsEnabled: false,
      originalOrderId: orderId,
      numberOfWooRefundRowsInspected: total,
      ...comparison,
    };
  }
}

// Purposefully no environment-based instance, app routes, process-global
// credentials, production use, or automatic job. The test must inject a fake
// HTTP client; accidental real network calls are not part of this phase.
