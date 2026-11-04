import { demoProducts, demoLine, SNAPSHOT_DATE } from './demo-catalog.js';
import { fetchLiveCatalog, freshLine } from './woocommerce.js';
import { AppError, RemoteError } from './errors.js';

export class Catalog {
  constructor(db, api, config) { this.db = db; this.api = api; this.config = config; this.cache = null; this.refreshing = null; }
  demo() {
    const stocks = new Map(this.db.prepare('SELECT * FROM demo_stock').all().map(row => [row.line_key, row.stock]));
    return demoProducts.map(p => ({ ...p,
      stock: p.type === 'simple' ? stocks.get(`${p.id}:0`) : null,
      stockStatus: p.type === 'simple' && stocks.get(`${p.id}:0`) <= 0 ? 'outofstock' : 'instock',
      variations: p.variations.map(v => { const stock = stocks.get(`${p.id}:${v.id}`); return { ...v, stock, stockStatus: stock <= 0 ? 'outofstock' : 'instock' }; }),
    }));
  }
  async get(force = false) {
    if (this.config.mode === 'demo') return { products: this.demo(), source: 'public-product-snapshot', fetchedAt: SNAPSHOT_DATE, isDemo: true, complete: false, unsupported: 0 };
    if (!this.config.configured) {
      const cached = this.db.prepare('SELECT * FROM catalog_cache WHERE id=1').get();
      if (cached) return { ...JSON.parse(cached.payload), stale: true, error: 'Credentials missing; showing the last saved catalogue. Checkout is disabled.' };
      return { products: [], source: 'woocommerce', fetchedAt: null, complete: false, error: 'Configure WooCommerce API credentials on the server to load the catalogue.' };
    }
    if (!force && this.cache && Date.now() - new Date(this.cache.fetchedAt).getTime() < 30000) return this.cache;
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      try {
        const result = await fetchLiveCatalog(this.api);
        this.cache = { ...result, isDemo: false, stale: false };
        this.db.prepare('INSERT INTO catalog_cache(id,payload,updated_at) VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at').run(JSON.stringify(this.cache), result.fetchedAt);
        return this.cache;
      } catch (error) {
        const cached = this.cache || (() => { const row = this.db.prepare('SELECT payload FROM catalog_cache WHERE id=1').get(); return row ? JSON.parse(row.payload) : null; })();
        if (cached) return { ...cached, stale: true, error: 'Refresh failed. Showing cached stock; checkout uses fresh WooCommerce availability.' };
        throw error;
      } finally { this.refreshing = null; }
    })();
    return this.refreshing;
  }
  async lines(items) {
    const catalog = this.config.mode === 'demo' ? { products: this.demo() } : await this.get();
    return items.map(item => {
      if (this.config.mode === 'demo') {
        const p = catalog.products.find(p => p.id === item.productId);
        if (!p) throw new AppError('Product not found. Refresh the catalogue.', 404);
        return { ...demoLine(p, item.variationId), quantity: item.quantity, stockKey: `${item.productId}:${item.variationId || 0}` };
      }
      const p = catalog.products.find(p => p.id === item.productId);
      const v = p?.variations.find(v => v.id === item.variationId);
      if (!p || (p.type === 'variable' && !v)) throw new AppError('Product or variation not found. Refresh the catalogue.', 404);
      const source = v || p;
      return { ...source, key: `${p.id}:${v?.id || 0}`, stockKey: v && !v.manageStock && p.manageStock ? `${p.id}:0` : `${p.id}:${v?.id || 0}`, productId: p.id, variationId: v?.id || 0, name: p.name, label: v?.label || '', quantity: item.quantity, soldIndividually: p.soldIndividually };
    });
  }
  async fresh(items) {
    if (this.config.mode === 'demo') return this.lines(items);
    const lines = [];
    for (const item of items) lines.push({ ...await freshLine(this.api, item.productId, item.variationId), quantity: item.quantity });
    return lines;
  }
  invalidate() { this.cache = null; }
}

export function validateAvailability(lines) {
  const grouped = new Map();
  for (const line of lines) {
    if (!line.purchasable) throw new AppError(`${line.name} is not available for sale.`, 409);
    if (line.soldIndividually && line.quantity > 1) throw new AppError(`${line.name} can only be sold one at a time.`, 409);
    if (line.manageStock || ['outofstock', 'onbackorder'].includes(line.stockStatus)) {
      const quantity = (grouped.get(line.stockKey)?.quantity || 0) + line.quantity;
      grouped.set(line.stockKey, { quantity, line });
    }
  }
  for (const { line, quantity } of grouped.values()) {
    const backorders = line.backorders === 'yes' ? Infinity : 0;
    if (line.stockStatus === 'outofstock' || (line.manageStock && line.stock != null && quantity > Number(line.stock) + backorders)) {
      throw new AppError(`Not enough stock for ${line.name}${line.label ? ` (${line.label})` : ''}. Refresh and adjust the cart.`, 409, 'INSUFFICIENT_STOCK');
    }
  }
}
