import { z } from 'zod';
import { AppError, RemoteError, now } from './errors.js';
import { audit } from './db.js';

// Shared inventory management for the shop (POS) and the website.
//
// WooCommerce stays the ONE stock authority: every POS sale already lowers
// Woo stock, and every website order does too. This service lets authorised
// staff change that same quantity (deliveries, damage, returns, stock counts)
// and retail prices from the POS, so both channels always see one number.
//
// Each change re-reads the live Woo quantity immediately before writing,
// writes the absolute result, then checks Woo's reply. Movements are kept in
// the existing append-only audit journal (no schema change, protected by the
// v9 triggers and by backup/restore comparisons).

export const ADJUST_REASONS = {
  receive: ['delivery', 'customer_return', 'transfer_in', 'found', 'correction'],
  remove: ['damaged', 'lost', 'theft', 'transfer_out', 'personal_use', 'sample', 'correction'],
  count: ['stock_count'],
};
export const REASON_LABELS = {
  delivery: 'New delivery / restock', customer_return: 'Customer return', transfer_in: 'Transfer in', found: 'Found in store',
  correction: 'Correction', damaged: 'Damaged', lost: 'Lost / missing', theft: 'Theft', transfer_out: 'Transfer out',
  personal_use: 'Staff / personal use', sample: 'Sample / display', stock_count: 'Stock count',
};
const STOCK_ACTIONS = ['inventory.stock_adjusted', 'inventory.stock_counted', 'inventory.stock_failed', 'inventory.stock_uncertain', 'inventory.price_changed'];
const MAX_STOCK = 1_000_000;

const identity = {
  productId: z.number().int().positive().max(2 ** 31),
  variationId: z.number().int().min(0).max(2 ** 31).default(0),
};
const note = z.string().trim().max(200).refine(v => !/[\r\n]/.test(v), 'Use one line without line breaks').default('');
const key = z.string().uuid();
export const adjustSchema = z.object({
  key, ...identity,
  type: z.enum(['receive', 'remove', 'count']),
  quantity: z.number().int().min(0).max(MAX_STOCK),
  reason: z.string().min(2).max(40),
  note,
  expectedStock: z.number().int().min(-MAX_STOCK).max(MAX_STOCK).nullable().optional(),
  enableTracking: z.boolean().default(false),
}).strict().superRefine((value, ctx) => {
  if (!ADJUST_REASONS[value.type].includes(value.reason)) ctx.addIssue({ code: 'custom', path: ['reason'], message: 'Choose a reason that matches this type of change' });
  if (value.type !== 'count' && value.quantity < 1) ctx.addIssue({ code: 'custom', path: ['quantity'], message: 'Enter at least 1 unit' });
  if (value.enableTracking && value.type !== 'count') ctx.addIssue({ code: 'custom', path: ['enableTracking'], message: 'Start tracking with a stock count' });
});
export const countSchema = z.object({
  key, note,
  lines: z.array(z.object({
    ...identity,
    counted: z.number().int().min(0).max(MAX_STOCK),
    expectedStock: z.number().int().min(-MAX_STOCK).max(MAX_STOCK).nullable(),
    enableTracking: z.boolean().default(false),
  }).strict()).min(1).max(200),
}).strict().superRefine((value, ctx) => {
  const seen = new Set();
  value.lines.forEach((line, index) => {
    const id = `${line.productId}:${line.variationId}`;
    if (seen.has(id)) ctx.addIssue({ code: 'custom', path: ['lines', index], message: 'Each stock line can be counted once per submission' });
    seen.add(id);
  });
});
const priceValue = z.string().trim().regex(/^\d{1,7}(\.\d{1,2})?$/, 'Use a GHS amount like 120 or 120.50');
export const priceSchema = z.object({
  key, ...identity,
  regularPrice: priceValue,
  salePrice: z.union([priceValue, z.literal('')]).default(''),
  expectedRegularPrice: z.string().max(20).optional(),
  note,
}).strict().superRefine((value, ctx) => {
  if (Number(value.regularPrice) <= 0) ctx.addIssue({ code: 'custom', path: ['regularPrice'], message: 'Regular price must be above zero' });
  if (value.salePrice !== '' && Number(value.salePrice) >= Number(value.regularPrice)) ctx.addIssue({ code: 'custom', path: ['salePrice'], message: 'Sale price must be lower than the regular price' });
});
export const movementQuery = z.object({
  productId: z.coerce.number().int().positive().optional(),
  variationId: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.coerce.number().int().positive().optional(),
  includeSales: z.enum(['0', '1']).default('1'),
});

const cents = value => value == null || value === '' || !Number.isFinite(Number(value)) ? null : Math.round(Number(value) * 100);
const quantity = value => value == null || String(value).trim() === '' || !Number.isFinite(Number(value)) ? null : Math.trunc(Number(value));
const decimal = value => (value / 100).toFixed(2);
const parse = text => { try { return JSON.parse(text); } catch { return null; } };

/** Gate for any inventory or price write. Never true on the read-only pilot or with the reservation bridge. */
export function inventoryWriteState(config) {
  if (config.mode === 'demo') return { enabled: true, reason: 'Demo quantities only. Your website is not changed.' };
  if (config.liveReadOnly) return { enabled: false, reason: 'The read-only live pilot cannot change WooCommerce stock or prices.' };
  if (config.onlineBridgeEnabled || config.onlineBridgeQuarantined) return { enabled: false, reason: 'Stock changes are locked while the reservation bridge profile is active or under review.' };
  if (!config.configured) return { enabled: false, reason: 'WooCommerce credentials are not configured on the server.' };
  if (!config.writesEnabled) return { enabled: false, reason: 'WooCommerce writes are not approved for this POS service.' };
  if (!config.inventoryWritesEnabled) return { enabled: false, reason: 'Stock management writes are switched off. Set POS_INVENTORY_WRITES_APPROVED=true on the trading service to enable them.' };
  return { enabled: true, reason: 'Changes are written to WooCommerce and apply to the website and the shop at once.' };
}

// One stock pool per row: a simple product, a variation with its own stock,
// or a variable product whose options all share the parent quantity.
export function stockPools(products, threshold) {
  const rows = [];
  for (const p of products || []) {
    if (p.type !== 'variable') {
      rows.push(poolRow(p, null, threshold));
      continue;
    }
    const shared = p.variations.filter(v => v.stockSource === 'parent');
    if (shared.length) {
      const first = shared[0];
      rows.push({
        ...poolRow({ ...p, stock: first.stock, manageStock: true, stockSource: 'parent', stockStatus: shared.every(v => v.stockStatus === 'outofstock') ? 'outofstock' : p.stockStatus, price: first.price }, null, threshold),
        label: `All options · shared stock (${shared.map(v => v.label).join(', ')})`, sharedOptions: shared.length,
      });
    }
    for (const v of p.variations) if (v.stockSource !== 'parent') rows.push(poolRow(p, v, threshold));
  }
  return rows;
}
function poolRow(p, v, threshold) {
  const source = v || p;
  const stockSource = source.stockSource || (source.manageStock ? (v ? 'variation' : 'product') : 'untracked');
  const stock = source.manageStock && Number.isFinite(source.stock) ? source.stock : null;
  let status = 'ok';
  if (stockSource === 'unknown' || (source.manageStock && stock == null)) status = 'unknown';
  else if (!source.manageStock) status = source.stockStatus === 'outofstock' ? 'out' : 'untracked';
  else if (stock <= 0 || source.stockStatus === 'outofstock') status = 'out';
  else if (stock <= threshold) status = 'low';
  return {
    productId: p.id, variationId: v?.id || 0, key: `${p.id}:${v?.id || 0}`,
    name: p.name, label: v?.label || (p.type === 'variable' ? 'Product level' : 'Standard'),
    sku: source.sku || '', image: source.image || p.image || '', category: p.category || 'Uncategorized',
    price: Number.isSafeInteger(source.price) ? source.price : 0,
    stock, manageStock: Boolean(source.manageStock), stockSource, stockStatus: source.stockStatus || 'instock',
    backordersAllowed: Boolean(source.backordersAllowed), status, priceEditable: !(p.type === 'variable' && !v),
  };
}

export class InventoryService {
  constructor(db, catalog, api, config) {
    this.db = db; this.catalog = catalog; this.api = api; this.config = config;
    this.queue = Promise.resolve();
  }
  // Serialise writes from this service so two staff members cannot interleave
  // read-then-write on the same Woo quantity through the POS.
  exclusive(work) {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => {});
    return run;
  }
  writes() { return inventoryWriteState(this.config); }
  requireWrites() {
    const state = this.writes();
    if (!state.enabled) throw new AppError(state.reason, 403, 'INVENTORY_WRITES_LOCKED');
  }

  async overview({ refresh = false } = {}) {
    const catalog = await this.catalog.get(refresh);
    const threshold = this.config.lowStockThreshold;
    const sold = this.posUnitsSold(30);
    const lines = stockPools(catalog.products, threshold).map(line => {
      const units = line.variationId ? sold.get(line.key) || 0
        : line.stockSource === 'parent' ? [...sold.entries()].filter(([k]) => k.startsWith(`${line.productId}:`)).reduce((s, [, n]) => s + n, 0)
          : sold.get(line.key) || 0;
      const daily = units / 30;
      return { ...line, posSold30: units, daysOfCover: line.stock != null && daily > 0 ? Math.max(0, Math.floor(line.stock / daily)) : null };
    });
    const tracked = lines.filter(l => l.manageStock && l.stock != null);
    const summary = {
      products: catalog.products.length, stockLines: lines.length,
      unitsOnHand: tracked.reduce((s, l) => s + Math.max(0, l.stock), 0),
      retailValue: tracked.reduce((s, l) => s + Math.max(0, l.stock) * l.price, 0),
      low: lines.filter(l => l.status === 'low').length, out: lines.filter(l => l.status === 'out').length,
      untracked: lines.filter(l => l.status === 'untracked').length, unknown: lines.filter(l => l.status === 'unknown').length,
      missingSku: lines.filter(l => !l.sku).length, threshold,
    };
    const writes = this.writes();
    return {
      lines, summary, writes: { ...writes, demo: this.config.mode === 'demo', priceEditing: writes.enabled && this.config.mode !== 'demo' },
      reasons: ADJUST_REASONS, reasonLabels: REASON_LABELS,
      fetchedAt: catalog.fetchedAt, stale: Boolean(catalog.stale), error: catalog.error || '', complete: catalog.complete !== false || catalog.isDemo === true, isDemo: Boolean(catalog.isDemo),
    };
  }

  posUnitsSold(days) {
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const totals = new Map();
    for (const row of this.db.prepare("SELECT items_json FROM sales WHERE status IN ('paid','partially_refunded') AND COALESCE(paid_at,created_at)>=?").all(since)) {
      for (const item of parse(row.items_json) || []) {
        const id = `${item.productId}:${item.variationId || 0}`;
        totals.set(id, (totals.get(id) || 0) + (Number(item.quantity) || 0));
      }
    }
    return totals;
  }

  previous(keyValue) {
    const rows = this.db.prepare(`SELECT action,subject FROM audit WHERE action IN (${STOCK_ACTIONS.map(() => '?').join(',')})
      AND json_valid(subject) AND json_extract(subject,'$.key')=? ORDER BY id`).all(...STOCK_ACTIONS, keyValue);
    return rows.map(row => ({ action: row.action, ...parse(row.subject) }));
  }

  // Read the live stock owner for one pool directly from WooCommerce.
  async freshTarget(productId, variationId) {
    if (this.config.mode === 'demo') {
      const product = (await this.catalog.get()).products.find(p => p.id === productId);
      const option = variationId ? product?.variations.find(v => v.id === variationId) : null;
      if (!product || (variationId && !option) || (!variationId && product.type === 'variable')) throw new AppError('Stock line not found. Refresh inventory.', 404);
      const source = option || product;
      return { demo: true, productId, variationId, name: product.name, label: option?.label || 'Standard', sku: source.sku || '',
        manageStock: true, stock: quantity(this.db.prepare('SELECT stock FROM demo_stock WHERE line_key=?').get(`${productId}:${variationId}`)?.stock) ?? 0 };
    }
    const product = await this.api.product(productId);
    if (Number(product?.id) !== productId || product.status === 'trash' || !['simple', 'variable'].includes(product.type)) {
      throw new AppError('This WooCommerce product is not available for stock management.', 409);
    }
    if (!variationId) {
      if (product.type === 'variable' && product.manage_stock !== true) {
        throw new AppError('This variable product does not hold shared stock. Adjust each size/colour option instead.', 409);
      }
      return { productId, variationId: 0, name: product.name, label: product.type === 'variable' ? 'All options · shared stock' : 'Standard', sku: product.sku || '',
        manageStock: product.manage_stock === true, stock: quantity(product.stock_quantity),
        regularPrice: product.regular_price ?? '', salePrice: product.sale_price ?? '', type: product.type };
    }
    if (product.type !== 'variable') throw new AppError('A simple product has no options.', 400);
    const option = await this.api.variation(productId, variationId);
    if (Number(option?.id) !== variationId || (option.parent_id != null && Number(option.parent_id) !== productId) || option.status === 'trash') {
      throw new AppError('This option does not belong to the selected WooCommerce product.', 409);
    }
    if (option.manage_stock === 'parent' || (option.manage_stock !== true && product.manage_stock === true)) {
      throw new AppError('This option shares stock with the whole product. Adjust the "All options · shared stock" row instead.', 409, 'SHARED_PARENT_STOCK');
    }
    const label = (option.attributes || []).map(a => a.option).join(' / ') || `Option ${variationId}`;
    return { productId, variationId, name: product.name, label, sku: option.sku || product.sku || '',
      manageStock: option.manage_stock === true, stock: quantity(option.stock_quantity),
      regularPrice: option.regular_price ?? '', salePrice: option.sale_price ?? '', type: 'variation' };
  }

  async writeStock(target, after) {
    if (target.demo) {
      this.db.prepare('INSERT INTO demo_stock(line_key,stock) VALUES (?,?) ON CONFLICT(line_key) DO UPDATE SET stock=excluded.stock').run(`${target.productId}:${target.variationId}`, after);
      return after;
    }
    const body = { manage_stock: true, stock_quantity: after };
    const saved = target.variationId ? await this.api.updateVariation(target.productId, target.variationId, body) : await this.api.updateProduct(target.productId, body);
    return quantity(saved?.stock_quantity);
  }

  record(user, action, entry) {
    audit(this.db, user.id, action, JSON.stringify({ v: 1, ...entry, by: user.name, at: now() }));
  }

  /** Apply one stock change. Returns the recorded movement. */
  adjust(user, input) {
    this.requireWrites();
    return this.exclusive(() => this.applyAdjust(user, input));
  }
  async applyAdjust(user, input) {
    const prior = this.previous(input.key);
    const done = prior.find(entry => ['inventory.stock_adjusted', 'inventory.stock_counted'].includes(entry.action));
    if (done) return { movement: done, replayed: true };
    if (prior.some(entry => entry.action === 'inventory.stock_uncertain')) {
      throw new AppError('The earlier attempt with this request may have reached WooCommerce. Refresh inventory and check the quantity before entering a new change.', 409, 'INVENTORY_UNCERTAIN');
    }
    const target = await this.freshTarget(input.productId, input.variationId);
    const base = { key: input.key, productId: input.productId, variationId: input.variationId, name: target.name, label: target.label, sku: target.sku,
      type: input.type, reason: input.reason, note: input.note, channel: this.config.mode === 'demo' ? 'demo' : 'woocommerce' };
    if (!target.manageStock && !input.enableTracking) {
      throw new AppError('WooCommerce does not track stock for this item. Use "Stock count" and tick "Start tracking stock" to set its quantity.', 409, 'STOCK_UNTRACKED');
    }
    const before = target.manageStock ? target.stock : null;
    if (target.manageStock && before == null) throw new AppError('WooCommerce did not return a stock quantity for this item. Review it in WooCommerce first.', 409, 'STOCK_UNAVAILABLE');
    // A count records what is physically on the shelf. If the online number
    // moved since the counter loaded it (e.g. a website sale), the count may
    // already include or exclude that sale, so ask them to re-check.
    if (input.type === 'count' && input.expectedStock !== undefined && input.expectedStock !== before) {
      throw new AppError(`Stock for ${target.name}${target.label ? ` (${target.label})` : ''} changed from ${input.expectedStock ?? 'untracked'} to ${before ?? 'untracked'} while you were counting (likely a website or shop sale). Re-check the shelf and enter the count again.`, 409, 'STOCK_CHANGED');
    }
    let after;
    if (input.type === 'count') after = input.quantity;
    else if (input.type === 'receive') after = (before ?? 0) + input.quantity;
    else {
      if ((before ?? 0) - input.quantity < 0) throw new AppError(`Only ${before ?? 0} in stock for ${target.name}${target.label ? ` (${target.label})` : ''}. You cannot remove ${input.quantity}.`, 409, 'INSUFFICIENT_STOCK');
      after = before - input.quantity;
    }
    if (after > MAX_STOCK) throw new AppError('Resulting stock is too large.', 400);
    const movement = { ...base, before, after, delta: after - (before ?? 0), startedTracking: !target.manageStock,
      changedSinceViewed: input.expectedStock != null && input.expectedStock !== before };
    if (input.type === 'count' && before === after) {
      this.record(user, 'inventory.stock_counted', { ...movement, delta: 0, written: false });
      return { movement: { ...movement, delta: 0, written: false, action: 'inventory.stock_counted' } };
    }
    let confirmed;
    try {
      confirmed = await this.writeStock(target, after);
    } catch (error) {
      const uncertain = error instanceof RemoteError ? Boolean(error.uncertain) : !(error instanceof AppError);
      this.record(user, uncertain ? 'inventory.stock_uncertain' : 'inventory.stock_failed', { ...movement, error: String(error.message || 'Write failed').slice(0, 200) });
      if (uncertain) throw new AppError('WooCommerce did not confirm the stock change. Refresh inventory and check the quantity before trying again.', 502, 'INVENTORY_UNCERTAIN');
      throw error;
    } finally { this.catalog.invalidate(); }
    if (confirmed !== after) {
      this.record(user, 'inventory.stock_uncertain', { ...movement, confirmed, error: 'WooCommerce returned a different quantity' });
      throw new AppError(`WooCommerce now shows ${confirmed ?? 'no quantity'} instead of ${after}. Refresh inventory and review this item.`, 502, 'INVENTORY_UNCERTAIN');
    }
    const action = input.type === 'count' ? 'inventory.stock_counted' : 'inventory.stock_adjusted';
    this.record(user, action, { ...movement, written: true });
    return { movement: { ...movement, written: true, action } };
  }

  /** Stocktake: apply many counted quantities, one line at a time. */
  count(user, input) {
    this.requireWrites();
    return this.exclusive(async () => {
      const results = [];
      for (const [index, line] of input.lines.entries()) {
        // Derive a stable per-line key so a resubmitted batch never doubles up.
        const lineKey = deriveKey(input.key, index, line);
        try {
          const result = await this.applyAdjust(user, { key: lineKey, productId: line.productId, variationId: line.variationId, type: 'count',
            quantity: line.counted, reason: 'stock_count', note: input.note, expectedStock: line.expectedStock, enableTracking: line.enableTracking });
          results.push({ productId: line.productId, variationId: line.variationId, ok: true, movement: result.movement });
        } catch (error) {
          results.push({ productId: line.productId, variationId: line.variationId, ok: false, code: error.code || 'ERROR', error: error instanceof AppError ? error.message : 'Unexpected error' });
        }
      }
      return { results, applied: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length };
    });
  }

  /** Change a retail price on WooCommerce (website and POS use the same price). */
  price(user, input) {
    this.requireWrites();
    if (this.config.mode === 'demo') throw new AppError('Demo prices come from a fixed product snapshot and cannot be edited.', 403, 'DEMO_PRICES_FIXED');
    return this.exclusive(async () => {
      const done = this.previous(input.key).find(entry => entry.action === 'inventory.price_changed');
      if (done) return { change: done, replayed: true };
      const target = await this.freshTarget(input.productId, input.variationId);
      if (target.type === 'variable') throw new AppError('Prices are set on each option of a variable product.', 409);
      if (input.expectedRegularPrice !== undefined && cents(input.expectedRegularPrice) !== cents(target.regularPrice)) {
        throw new AppError('The price was changed in WooCommerce since you opened it. Refresh and try again.', 409, 'PRICE_CHANGED');
      }
      const body = { regular_price: decimal(cents(input.regularPrice)), sale_price: input.salePrice === '' ? '' : decimal(cents(input.salePrice)) };
      const saved = input.variationId ? await this.api.updateVariation(input.productId, input.variationId, body) : await this.api.updateProduct(input.productId, body);
      this.catalog.invalidate();
      const change = { key: input.key, productId: input.productId, variationId: input.variationId, name: target.name, label: target.label, sku: target.sku,
        type: 'price', note: input.note, before: { regular: target.regularPrice, sale: target.salePrice }, after: { regular: saved?.regular_price ?? body.regular_price, sale: saved?.sale_price ?? body.sale_price } };
      if (cents(change.after.regular) !== cents(body.regular_price)) throw new AppError('WooCommerce did not confirm the new price. Refresh and review this item.', 502, 'INVENTORY_UNCERTAIN');
      this.record(user, 'inventory.price_changed', change);
      return { change: { ...change, action: 'inventory.price_changed' } };
    });
  }

  movements(options) {
    const params = [...STOCK_ACTIONS];
    let where = `action IN (${STOCK_ACTIONS.map(() => '?').join(',')}) AND json_valid(subject)`;
    if (options.productId) { where += " AND json_extract(subject,'$.productId')=?"; params.push(options.productId); }
    if (options.productId && options.variationId !== undefined) { where += " AND json_extract(subject,'$.variationId')=?"; params.push(options.variationId); }
    if (options.before) { where += ' AND id<?'; params.push(options.before); }
    const rows = this.db.prepare(`SELECT id,actor,action,subject,created_at FROM audit WHERE ${where} ORDER BY id DESC LIMIT ?`).all(...params, options.limit + 1);
    const hasMore = rows.length > options.limit;
    const movements = rows.slice(0, options.limit).map(row => {
      const entry = parse(row.subject) || {};
      return { id: `a${row.id}`, cursor: row.id, source: 'adjustment', action: row.action, at: row.created_at, by: entry.by || row.actor,
        productId: entry.productId, variationId: entry.variationId, name: entry.name, label: entry.label, sku: entry.sku,
        type: entry.type, reason: entry.reason, reasonLabel: REASON_LABELS[entry.reason] || '', note: entry.note || '',
        before: entry.before, after: entry.after, delta: entry.delta ?? null, status: row.action.replace('inventory.', ''), error: entry.error || '' };
    });
    let sales = [];
    if (options.includeSales === '1' && !options.before) {
      const oldest = hasMore ? movements.at(-1)?.at : null;
      const rowsSales = this.db.prepare(`SELECT id,number,cashier_name,items_json,status,COALESCE(paid_at,created_at) AS at FROM sales
        WHERE status IN ('paid','partially_refunded','refunded') ${oldest ? 'AND COALESCE(paid_at,created_at)>=?' : ''} ORDER BY at DESC LIMIT 200`).all(...(oldest ? [oldest] : []));
      for (const sale of rowsSales) {
        for (const item of parse(sale.items_json) || []) {
          if (options.productId && item.productId !== options.productId) continue;
          if (options.productId && options.variationId && (item.variationId || 0) !== options.variationId) continue;
          sales.push({ id: `s${sale.id}:${item.productId}:${item.variationId || 0}`, source: 'pos_sale', action: 'pos.sale', at: sale.at, by: sale.cashier_name,
            productId: item.productId, variationId: item.variationId || 0, name: item.name, label: item.label || '', sku: item.sku || '',
            type: 'sale', reason: 'pos_sale', reasonLabel: `POS sale ${sale.number}`, note: '', before: null, after: null, delta: -Number(item.quantity || 0), status: sale.status });
        }
      }
    }
    const merged = [...movements, ...sales].sort((a, b) => String(b.at).localeCompare(String(a.at)));
    return { movements: merged, hasMore, nextCursor: hasMore ? movements.at(-1).cursor : null,
      notice: 'Website orders lower WooCommerce stock directly; they show in the live quantity, not in this list.' };
  }

  async exportCsv() {
    const { lines } = await this.overview();
    const cell = value => {
      let text = String(value ?? '');
      if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
      return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
    };
    const header = ['Product ID', 'Option ID', 'Product', 'Option', 'SKU', 'Category', 'Retail price (GHS)', 'Stock', 'Status', 'Tracking', 'POS units sold (30 days)', 'Days of cover'];
    const body = lines.map(l => [l.productId, l.variationId, l.name, l.label, l.sku, l.category, decimal(l.price), l.stock ?? '', l.status, l.manageStock ? l.stockSource : 'not tracked', l.posSold30, l.daysOfCover ?? ''].map(cell).join(','));
    return [header.join(','), ...body].join('\n') + '\n';
  }
}

function deriveKey(batchKey, index, line) {
  // Keep it a valid UUID shape while staying unique per batch line.
  const suffix = (line.productId * 1000003 + line.variationId + index).toString(16).padStart(12, '0').slice(-12);
  return `${batchKey.slice(0, 24)}${suffix}`;
}
