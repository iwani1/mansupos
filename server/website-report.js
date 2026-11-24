import { AppError } from './errors.js';

// Website (online checkout) orders for the Reports page, read from
// WooCommerce. POS orders are excluded: they are already in the POS report,
// marked by created_via=mansu-pos or the _mansu_pos_channel meta.
// Read-only: nothing is written to WooCommerce or the POS ledger.

const PAID_STATUSES = ['processing', 'completed', 'refunded'];
const PAGE_SIZE = 100;
const MAX_PAGES = 20; // 2,000 orders per period; beyond that the report says it is partial
const FIELDS = 'id,number,status,created_via,currency,total,date_created_gmt,date_paid_gmt,payment_method,payment_method_title,refunds,line_items,meta_data';
const CACHE_MS = 60000;

const cents = value => Math.round(Number(value || 0) * 100);

export function isPosOrder(order) {
  if (order.created_via === 'mansu-pos') return true;
  return Array.isArray(order.meta_data) && order.meta_data.some(m => m?.key === '_mansu_pos_channel' && m.value === 'mansu-pos');
}

export function summariseWebsiteOrders(orders, { since, days, partial = false }) {
  const site = orders.filter(order => !isPosOrder(order) && PAID_STATUSES.includes(order.status) && order.currency === 'GHS');
  const refundedOf = order => Math.min(cents(order.total), (order.refunds || []).reduce((sum, r) => sum + Math.abs(cents(r?.total)), 0));
  const dayOf = order => String(order.date_paid_gmt || order.date_created_gmt || '').slice(0, 10);
  const gross = site.reduce((sum, o) => sum + cents(o.total), 0);
  const refunded = site.reduce((sum, o) => sum + refundedOf(o), 0);
  const daily = Array.from({ length: days }, (_, i) => {
    const date = new Date(since); date.setUTCDate(date.getUTCDate() + i);
    const key = date.toISOString().slice(0, 10);
    const matches = site.filter(o => dayOf(o) === key);
    return { date: key, total: matches.reduce((sum, o) => sum + cents(o.total) - refundedOf(o), 0), count: matches.length };
  });
  const methods = new Map();
  for (const o of site) {
    const name = String(o.payment_method_title || o.payment_method || 'Other').slice(0, 60);
    const m = methods.get(name) || { name, count: 0, total: 0 };
    m.count++; m.total += cents(o.total) - refundedOf(o);
    methods.set(name, m);
  }
  const products = new Map();
  for (const o of site) {
    if (o.status === 'refunded') continue;
    for (const item of o.line_items || []) {
      const key = `${item.product_id}:${item.variation_id || 0}`;
      const p = products.get(key) || { name: String(item.name || 'Item').slice(0, 120), quantity: 0, total: 0 };
      p.quantity += Number(item.quantity) || 0; p.total += cents(item.total);
      products.set(key, p);
    }
  }
  const total = gross - refunded;
  return {
    days, since: since.toISOString(), partial,
    total, gross, refunded, orders: site.length,
    items: site.filter(o => o.status !== 'refunded').reduce((n, o) => n + (o.line_items || []).reduce((s, i) => s + (Number(i.quantity) || 0), 0), 0),
    average: site.length ? Math.round(total / site.length) : 0,
    daily,
    methods: [...methods.values()].sort((a, b) => b.total - a.total),
    topProducts: [...products.values()].sort((a, b) => b.quantity - a.quantity).slice(0, 8),
    scope: 'Paid website orders (processing, completed or refunded) created on the website in this period, after WooCommerce refunds. POS orders are not included here; they are in the POS figures above.',
  };
}

export class WebsiteReport {
  constructor(api, config) { this.api = api; this.config = config; this.cache = new Map(); }
  available() { return this.config.mode !== 'demo' && this.config.configured && !this.config.liveReadOnly; }
  async report(days) {
    if (!this.available()) {
      throw new AppError(this.config.mode === 'demo' ? 'The demo has no website orders.' : 'Website orders cannot be read by this POS service.', 409, 'WEBSITE_REPORT_UNAVAILABLE');
    }
    const since = new Date(); since.setUTCHours(0, 0, 0, 0); since.setUTCDate(since.getUTCDate() - days + 1);
    const key = `${days}:${since.toISOString()}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
    const orders = [];
    let partial = false;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const result = await this.api.request('orders', { query: {
        after: since.toISOString(), dates_are_gmt: true, status: PAID_STATUSES.join(','),
        per_page: PAGE_SIZE, page, orderby: 'date', order: 'asc', _fields: FIELDS,
      } });
      const batch = Array.isArray(result?.data) ? result.data : [];
      orders.push(...batch);
      if (batch.length < PAGE_SIZE || page >= (result.pages || 1)) break;
      if (page === MAX_PAGES) partial = true;
    }
    const value = summariseWebsiteOrders(orders, { since, days, partial });
    this.cache.set(key, { at: Date.now(), value });
    if (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value);
    return value;
  }
}
