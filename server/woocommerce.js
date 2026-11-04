import { RemoteError } from './errors.js';

const SAFE_RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export class WooCommerce {
  constructor(config, fetchImpl = fetch, logger = null) { this.config = config; this.fetch = fetchImpl; this.logger = logger; }
  async request(resource, { method = 'GET', body, query = {}, allowMissing = false } = {}) {
    if (!this.config.configured) throw new RemoteError('WooCommerce credentials are not configured. The demo remains available.', 503);
    const url = new URL(`${this.config.storeUrl}/wp-json/wc/v3/${resource}`);
    for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, String(value));
    const idempotent = method === 'GET' || method === 'HEAD';
    const attempts = idempotent ? 3 : 1;
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await this.once(url, { method, body, allowMissing });
      } catch (error) {
        lastError = error;
        if (!idempotent || attempt === attempts || !error.retryable) throw error;
        const delay = Math.min(2000, 250 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 100);
        this.logger?.warn({ msg: 'woocommerce.read_retry', resource, attempt, delay });
        await sleep(delay);
      }
    }
    throw lastError;
  }
  async once(url, { method, body, allowMissing }) {
    let response;
    try {
      response = await this.fetch(url, {
        method, redirect: 'error',
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.config.consumerKey}:${this.config.consumerSecret}`).toString('base64')}`,
          'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'MansuPOS/1.1',
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(20000),
      });
    } catch {
      const error = new RemoteError('The store could not be reached. No automatic checkout retry was made; reconcile the sale before trying again.', 502, method !== 'GET');
      error.retryable = method === 'GET';
      throw error;
    }
    if (allowMissing && response.status === 404) return null;
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch {
      const error = new RemoteError('The store returned an unexpected response. Check the WooCommerce URL and server configuration.', 502, method !== 'GET');
      error.retryable = false;
      throw error;
    }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new RemoteError('WooCommerce denied access. Check the API key permissions and server configuration.', response.status);
      if (response.status === 404) throw new RemoteError('The WooCommerce REST endpoint was not found. Check the store URL and permalink settings.', 502);
      const error = new RemoteError(`WooCommerce rejected the request (HTTP ${response.status}). Review the order in WooCommerce before retrying.`, 502, method !== 'GET' && response.status >= 500);
      error.retryable = method === 'GET' && SAFE_RETRY_STATUS.has(response.status);
      throw error;
    }
    return { data, total: Number(response.headers.get('x-wp-total') || 0), pages: Number(response.headers.get('x-wp-total-pages') || 1) };
  }
  async products(page = 1) { return this.request('products', { query: { page, per_page: 100, status: 'publish', orderby: 'date', order: 'desc' } }); }
  async variations(productId, page = 1) { return this.request(`products/${productId}/variations`, { query: { page, per_page: 100 } }); }
  async product(id) { return (await this.request(`products/${id}`)).data; }
  async variation(productId, id) { return (await this.request(`products/${productId}/variations/${id}`)).data; }
  async order(id) { return (await this.request(`orders/${id}`)).data; }
  async createOrder(body) { return (await this.request('orders', { method: 'POST', body: { created_via: 'mansu-pos', ...body } })).data; }
  async updateOrder(id, body) { return (await this.request(`orders/${id}`, { method: 'PUT', body })).data; }
  async findOrderByKey(key, createdAt) {
    const after = new Date(new Date(createdAt).getTime() - 300000).toISOString();
    for (let page = 1; page <= 10; page++) {
      const result = await this.request('orders', { query: { after, per_page: 100, page, orderby: 'date', order: 'asc', status: 'any' } });
      const match = result.data.find(order => order.meta_data?.some(meta => meta.key === '_mansu_pos_key' && meta.value === key));
      if (match) return match;
      if (page >= result.pages) break;
    }
    return null;
  }
}

const cents = value => Math.round(Number(value || 0) * 100);
const cleanImage = value => {
  try { const url = new URL(value); return url.protocol === 'https:' ? url.href : ''; } catch { return ''; }
};
function mapProduct(p) {
  return {
    id: p.id, name: p.name, type: p.type, sku: p.sku || '', barcode: p.sku || '',
    price: cents(p.price), image: cleanImage(p.images?.[0]?.src),
    category: p.categories?.[0]?.name || 'Uncategorized', categories: (p.categories || []).map(c => c.name),
    permalink: cleanImage(p.permalink), manageStock: Boolean(p.manage_stock),
    stock: p.stock_quantity == null ? null : Number(p.stock_quantity),
    stockStatus: p.stock_status || 'instock', backorders: p.backorders || 'no',
    purchasable: p.purchasable !== false && p.price !== '' && p.price != null,
    soldIndividually: Boolean(p.sold_individually), variations: [],
  };
}
function mapVariation(v, p) {
  const manages = v.manage_stock === 'parent' ? Boolean(p.manage_stock) : Boolean(v.manage_stock ?? p.manage_stock);
  const source = v.manage_stock === true ? v : p;
  return {
    id: v.id, sku: v.sku || '', barcode: v.sku || '',
    label: (v.attributes || []).map(a => a.option).join(' / ') || `Variation ${v.id}`,
    attributes: (v.attributes || []).map(a => ({ name: a.name, option: a.option })),
    price: cents(v.price), image: cleanImage(v.image?.src) || cleanImage(p.images?.[0]?.src),
    manageStock: manages, stock: manages ? Number(source.stock_quantity ?? 0) : null,
    stockStatus: v.stock_status || 'instock', backorders: v.backorders || 'no',
    purchasable: v.purchasable !== false && v.price !== '' && v.price != null,
  };
}
export async function fetchLiveCatalog(api, { maxPages = 100 } = {}) {
  const products = [];
  let unsupported = 0;
  let complete = true;
  for (let page = 1; page <= maxPages; page++) {
    const result = await api.products(page);
    for (const raw of result.data) {
      if (!['simple', 'variable'].includes(raw.type)) { unsupported++; continue; }
      const p = mapProduct(raw);
      if (p.type === 'variable') {
        for (let vPage = 1; vPage <= maxPages; vPage++) {
          const variations = await api.variations(p.id, vPage);
          p.variations.push(...variations.data.map(v => mapVariation(v, raw)));
          if (vPage >= variations.pages) break;
          if (vPage === maxPages) complete = false;
        }
        p.purchasable = p.variations.some(v => v.purchasable);
      }
      products.push(p);
    }
    if (page >= result.pages) break;
    if (page === maxPages) complete = false;
  }
  return { products, unsupported, source: 'woocommerce', fetchedAt: new Date().toISOString(), complete };
}
export async function freshLine(api, productId, variationId) {
  const p = await api.product(productId);
  if (p.status !== 'publish' || !['simple', 'variable'].includes(p.type)) throw new RemoteError('This product is not available for POS checkout.', 409);
  const mapped = mapProduct(p);
  let variant;
  if (p.type === 'variable') {
    if (!variationId) throw new RemoteError('A product variation is required.', 400);
    const v = await api.variation(productId, variationId);
    variant = mapVariation(v, p);
  } else if (variationId) throw new RemoteError('A simple product cannot have a variation.', 400);
  const source = variant || mapped;
  if (!source.purchasable) throw new RemoteError(`${p.name} is not purchasable.`, 409);
  return {
    key: `${productId}:${variationId || 0}`, stockKey: variant && !variant.manageStock && mapped.manageStock ? `${productId}:0` : `${productId}:${variationId || 0}`,
    productId, variationId: variationId || 0, name: p.name, label: variant?.label || '',
    sku: source.sku, barcode: source.barcode, image: source.image, price: source.price,
    manageStock: source.manageStock, stock: source.stock, stockStatus: source.stockStatus,
    backorders: source.backorders, purchasable: source.purchasable, soldIndividually: mapped.soldIndividually,
  };
}
