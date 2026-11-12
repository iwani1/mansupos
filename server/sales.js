import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError, now } from './errors.js';
import { audit, saleView } from './db.js';
import { validateAvailability } from './catalog.js';
import { ShiftService } from './shifts.js';

export const prepareSchema = z.object({
  idempotencyKey: z.string().uuid(),
  saleType: z.enum(['retail', 'wholesale']).optional().default('retail'),
  // A buyer name is optional on new wholesale orders. buyerId remains accepted
  // for outstanding orders made by the previous named-buyer checkout.
  buyerId: z.string().uuid().optional(),
  buyerName: z.string().trim().max(120).optional(),
  wholesaleApproved: z.boolean().optional().default(false),
  items: z.array(z.object({
    productId: z.number().int().positive(), variationId: z.number().int().min(0).optional().default(0),
    quantity: z.number().int().min(1).max(999), agreedUnitPrice: z.number().int().min(1).max(100000000).optional(),
  }).strict()).min(1).max(100),
  note: z.string().trim().max(250).optional().default(''),
}).strict().superRefine((value, ctx) => {
  if (value.saleType === 'wholesale') {
    // eslint-disable-next-line no-control-regex -- Buyer names appear on orders, receipts and exports.
    if (value.buyerName && (value.buyerName.length < 2 || /[\u0000-\u001f\u007f]/.test(value.buyerName))) ctx.addIssue({ code: 'custom', path: ['buyerName'], message: 'Use a single-line buyer name of at least two characters, or leave it blank.' });
    if (value.buyerId && value.buyerName) ctx.addIssue({ code: 'custom', path: ['buyerName'], message: 'Provide either a buyer name or an existing buyer ID, not both.' });
    value.items.forEach((item, i) => { if (item.agreedUnitPrice === undefined) ctx.addIssue({ code: 'custom', path: ['items', i, 'agreedUnitPrice'], message: 'Enter an agreed tax-inclusive unit price for every wholesale line.' }); });
    if (!value.wholesaleApproved) ctx.addIssue({ code: 'custom', path: ['wholesaleApproved'], message: 'An owner or manager must approve the wholesale quote before preparing an order.' });
  } else {
    if (value.buyerId || value.buyerName !== undefined || value.wholesaleApproved) ctx.addIssue({ code: 'custom', path: ['buyerName'], message: 'Buyer and approval require a wholesale sale.' });
    value.items.forEach((item, i) => { if (item.agreedUnitPrice !== undefined) ctx.addIssue({ code: 'custom', path: ['items', i, 'agreedUnitPrice'], message: 'Retail prices come from WooCommerce; do not send prices from the browser.' }); });
  }
});
export const paymentSchema = z.object({
  method: z.enum(['cash', 'momo', 'card']),
  reference: z.string().trim().max(80).optional().default(''),
  tendered: z.number().int().min(0).max(100000000).optional(),
  confirmed: z.literal(true),
}).strict().superRefine((value, ctx) => {
  if (value.method !== 'cash' && !value.reference) ctx.addIssue({ code: 'custom', path: ['reference'], message: 'Enter the external payment reference.' });
  if (/\d{13,19}/.test(value.reference.replace(/\D/g, ''))) ctx.addIssue({ code: 'custom', path: ['reference'], message: 'Never enter a full card number. Use the merchant or terminal reference.' });
});
const methodNames = { cash: 'Cash', momo: 'Mobile Money (external)', card: 'Card (external terminal)' };
const methodCodes = { cash: 'pos_cash', momo: 'pos_momo', card: 'pos_card' };
const money = value => Math.round(Number(value || 0) * 100);
export const isSettled = status => ['paid', 'partially_refunded', 'refunded'].includes(status);
const RECOVERY_WINDOW_MS = 15 * 60000;

export function normalizeItems(items) {
  const merged = new Map();
  for (const item of items) {
    const key = `${item.productId}:${item.variationId || 0}`;
    const current = merged.get(key) || { productId: item.productId, variationId: item.variationId || 0, quantity: 0, ...(item.agreedUnitPrice !== undefined ? { agreedUnitPrice: item.agreedUnitPrice } : {}) };
    if (current.agreedUnitPrice !== item.agreedUnitPrice) throw new AppError('Use one agreed unit price for each product option in a wholesale order.', 400);
    current.quantity += item.quantity;
    if (current.quantity > 999) throw new AppError('A single cart line cannot exceed 999 units.', 400);
    merged.set(key, current);
  }
  return [...merged.values()].sort((a, b) => a.productId - b.productId || a.variationId - b.variationId);
}
const sha256 = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fingerprint = (items, note = '', saleType = 'retail', buyerId = '', buyerName = '') => sha256(saleType === 'wholesale'
  // Preserve the old ID-based fingerprint so interrupted named-buyer orders
  // retain their idempotency keys. New name-only and unnamed orders include
  // the exact normalized optional name in their own fingerprint.
  ? { saleType, buyerId, ...(!buyerId ? { buyerName } : {}), items: normalizeItems(items), note: String(note || '').trim() }
  : { items: normalizeItems(items), note: String(note || '').trim() });
const quoteHash = (row, items) => sha256({ buyerId: row.buyer_id, buyerName: row.buyer_name, approvedBy: row.trade_approved_by_id, items });
const lineKey = item => `${item.productId ?? item.product_id}:${item.variationId ?? item.variation_id ?? 0}`;
const cents = value => value == null || value === '' || !Number.isFinite(Number(value)) ? NaN : Math.round(Number(value) * 100);
const asDecimal = value => (value / 100).toFixed(2);

// An approved wholesale unit amount includes all applicable tax. Woo's REST
// API accepts order-line totals *excluding* tax, so verify its calculation.
// Historical orders used `trade` metadata; accept those exact identities for
// reconciliation without permitting new legacy trade submissions.
function wholesaleLayout(row, order) {
  let quote;
  try { quote = JSON.parse(row.trade_quote_json || '[]'); } catch { quote = []; }
  if (!Array.isArray(quote) || !quote.length) return { problem: 'The agreed wholesale quote is missing. Review the sale.' };
  const meta = key => order.meta_data?.find(entry => entry.key === key)?.value;
  const kind = meta('_mansu_pos_sale_type');
  const prefix = kind === 'trade' ? '_mansu_pos_trade_' : '_mansu_pos_wholesale_';
  if (!['wholesale', 'trade'].includes(kind) ||
    (row.buyer_id ? meta(`${prefix}buyer_id`) !== row.buyer_id : Boolean(meta(`${prefix}buyer_id`))) ||
    (row.buyer_name ? meta(`${prefix}buyer`) !== row.buyer_name : Boolean(meta(`${prefix}buyer`))) ||
    meta(`${prefix}approver`) !== row.trade_approved_by_id ||
    meta(`${prefix}approver_name`) !== row.trade_approved_by_name ||
    meta(`${prefix}approved_at`) !== row.trade_approved_at || meta('_mansu_pos_quote_hash') !== quoteHash(row, quote)) {
    return { problem: 'WooCommerce does not match the approved wholesale quote details. Review the order.' };
  }
  if ((order.billing?.first_name ?? '') !== row.buyer_name || !Array.isArray(order.line_items) || order.line_items.length !== quote.length ||
    ['fee_lines', 'coupon_lines', 'shipping_lines'].some(key => !Array.isArray(order[key]) || order[key].length) ||
    cents(order.shipping_total) !== 0 || cents(order.discount_total) !== 0) {
    return { problem: 'WooCommerce changed the wholesale name, lines, fees, discounts, or shipping. Review the order.' };
  }
  const lines = new Map();
  for (const item of order.line_items) {
    const key = lineKey(item);
    if (lines.has(key) || !Number.isInteger(Number(item.id)) || Number(item.id) <= 0) return { problem: 'WooCommerce returned ambiguous wholesale order lines. Review the order.' };
    lines.set(key, item);
  }
  const pairs = [];
  for (const agreed of quote) {
    const item = lines.get(lineKey(agreed));
    if (!item || Number(item.quantity) !== agreed.quantity) return { problem: 'WooCommerce changed a wholesale product, option, or quantity. Review the order.' };
    const itemMeta = key => item.meta_data?.find(entry => entry.key === key)?.value;
    if (itemMeta('Mansu agreed unit gross (GHS)') !== asDecimal(agreed.agreedUnitPrice) ||
      itemMeta('Mansu catalogue unit (GHS)') !== asDecimal(agreed.catalogueUnitPrice)) {
      return { problem: 'WooCommerce line price notes do not match the approved wholesale quote. Review the order.' };
    }
    pairs.push({ agreed, item });
  }
  return { pairs };
}
function wholesaleOrderProblem(row, order) {
  const layout = wholesaleLayout(row, order);
  if (layout.problem) return layout.problem;
  let gross = 0, tax = 0;
  for (const { agreed, item } of layout.pairs) {
    const net = cents(item.total), itemTax = cents(item.total_tax), subtotal = cents(item.subtotal);
    if (![net, itemTax, subtotal].every(Number.isSafeInteger) || net < 0 || itemTax < 0 || net !== subtotal || net + itemTax !== agreed.agreedUnitPrice * agreed.quantity) {
      return 'WooCommerce line prices or tax do not match the agreed tax-inclusive wholesale prices. Review the order.';
    }
    gross += net + itemTax; tax += itemTax;
  }
  if (gross !== cents(order.total) || tax !== cents(order.total_tax) || !Array.isArray(order.tax_lines) ||
    order.tax_lines.some(line => !Number.isSafeInteger(cents(line.tax_total)) || cents(line.shipping_tax_total) !== 0) ||
    order.tax_lines.reduce((sum, line) => sum + cents(line.tax_total), 0) !== tax) {
    return 'WooCommerce total or tax does not match the agreed wholesale quote. Review the order.';
  }
  return '';
}
function remotePaidAt(order) {
  const raw = order.date_paid_gmt || order.date_paid;
  if (!raw) return null;
  const text = String(raw);
  const date = /(?:Z|[+-]\d{2}:?\d{2})$/.test(text) ? new Date(text) : new Date(`${text}Z`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
function remoteRefunded(order) {
  return Math.abs((order.refunds || []).reduce((sum, refund) => sum + money(refund.total), 0));
}
function remotePaid(order) {
  return Boolean(remotePaidAt(order)) && ['processing', 'completed', 'refunded'].includes(order.status);
}
const wholesaleVerifiedSnapshot = order => JSON.stringify(order.line_items.map(item => ({
  key: lineKey(item), net: cents(item.total), tax: cents(item.total_tax),
})).sort((a, b) => a.key.localeCompare(b.key)));
function wholesalePaymentProblem(row, order) {
  if (!remotePaid(order)) return row.payment_method ? 'A wholesale payment recording was interrupted. Verify the external payment and Woo order before retrying.' : '';
  const posRecord = order.meta_data?.find(meta => meta.key === '_mansu_pos_payment_recorded')?.value;
  if (posRecord !== 'externally-collected' || !methodCodes[row.payment_method] || order.payment_method !== methodCodes[row.payment_method] ||
    !Number.isSafeInteger(row.tendered) || row.tendered < cents(order.total) ||
    (row.payment_method !== 'cash' && (!row.payment_reference || order.transaction_id !== row.payment_reference))) {
    return 'The paid wholesale order has no matching, fully verified POS payment record. Do not release goods; review it first.';
  }
  return '';
}
function assertOrderIdentity(row, order) {
  if (!order || !Number.isInteger(Number(order.id))) throw new AppError('WooCommerce returned an invalid order identity.', 502, 'RECONCILIATION_REQUIRED');
  if (row.woo_order_id && Number(order.id) !== Number(row.woo_order_id)) throw new AppError('WooCommerce order identity did not match this sale.', 409, 'RECONCILIATION_REQUIRED');
  const key = order.meta_data?.find(meta => meta.key === '_mansu_pos_key')?.value;
  if (key !== row.idempotency_key) throw new AppError('WooCommerce order identity did not match this checkout.', 409, 'RECONCILIATION_REQUIRED');
}

export class SalesService {
  constructor(db, catalog, api, config) { this.db = db; this.catalog = catalog; this.api = api; this.config = config; this.locks = new Set(); this.shifts = new ShiftService(db, config); }
  get(id, user) {
    const row = this.db.prepare('SELECT * FROM sales WHERE id=?').get(id);
    if (!row) throw new AppError('Sale not found.', 404);
    if (user.role === 'cashier' && row.cashier_id !== user.id) throw new AppError('You can only view your own sales.', 403);
    return row;
  }
  list(user, limit = 250) {
    const rows = user.role === 'cashier'
      ? this.db.prepare('SELECT * FROM sales WHERE cashier_id=? ORDER BY created_at DESC, id DESC LIMIT ?').all(user.id, limit)
      : this.db.prepare('SELECT * FROM sales ORDER BY created_at DESC, id DESC LIMIT ?').all(limit);
    return rows.map(saleView);
  }
  listPage(user, { limit = 250, cursor = '' } = {}) {
    const safeLimit = Math.max(1, Math.min(500, Number(limit) || 250));
    let after = null;
    if (cursor) {
      try { after = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8')); } catch { throw new AppError('Invalid sales cursor.', 400); }
      if (!after?.createdAt || !after?.id) throw new AppError('Invalid sales cursor.', 400);
    }
    const where = [];
    const params = [];
    if (user.role === 'cashier') { where.push('cashier_id=?'); params.push(user.id); }
    if (after) { where.push('(created_at < ? OR (created_at = ? AND id < ?))'); params.push(after.createdAt, after.createdAt, after.id); }
    const sql = `SELECT * FROM sales ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC, id DESC LIMIT ?`;
    const rows = this.db.prepare(sql).all(...params, safeLimit + 1);
    const hasMore = rows.length > safeLimit;
    const page = rows.slice(0, safeLimit);
    const last = page.at(-1);
    return { sales: page.map(saleView), hasMore, nextCursor: hasMore && last ? Buffer.from(JSON.stringify({ createdAt: last.created_at, id: last.id })).toString('base64url') : null };
  }
  async exclusive(key, fn) {
    if (this.locks.has(key)) throw new AppError('This sale is already being processed. Please wait.', 409, 'SALE_BUSY');
    this.locks.add(key);
    try { return await fn(); } finally { this.locks.delete(key); }
  }
  markReconcileAttempt(id) {
    this.db.prepare('UPDATE sales SET last_reconciled_at=?, reconcile_attempts=COALESCE(reconcile_attempts,0)+1 WHERE id=?').run(now(), id);
  }
  async repriceWholesaleOrder(row, created) {
    let order = created;
    for (let attempt = 0; attempt < 4; attempt++) {
      assertOrderIdentity(row, order);
      if (order.currency !== this.config.currency || order.status !== 'pending' || remotePaid(order)) throw new AppError('The store did not return an unpaid GHS wholesale order. Review it before collecting payment.', 409, 'RECONCILIATION_REQUIRED');
      const layout = wholesaleLayout(row, order);
      if (layout.problem) throw new AppError(layout.problem, 409, 'RECONCILIATION_REQUIRED');
      const problem = wholesaleOrderProblem(row, order);
      if (!problem) return order;
      const updates = [];
      for (const { agreed, item } of layout.pairs) {
        const net = cents(item.total), tax = cents(item.total_tax), target = agreed.agreedUnitPrice * agreed.quantity;
        if (![net, tax].every(Number.isSafeInteger) || net < 0 || tax < 0) throw new AppError(problem, 409, 'RECONCILIATION_REQUIRED');
        const gross = net + tax;
        if (gross === target) continue;
        // The Woo calculation supplies the effective rate and tax class for this
        // exact product/location. Recalculate there; never guess the tax in JS.
        let nextNet = gross > 0 && net > 0 ? Math.round(net * target / gross) : target;
        if (nextNet === net) nextNet += Math.sign(target - gross);
        if (!Number.isSafeInteger(nextNet) || nextNet < 1 || nextNet > 100000000) throw new AppError(problem, 409, 'RECONCILIATION_REQUIRED');
        updates.push({ id: item.id, subtotal: asDecimal(nextNet), total: asDecimal(nextNet) });
      }
      if (!updates.length) throw new AppError(problem, 409, 'RECONCILIATION_REQUIRED');
      order = await this.api.updateOrder(row.woo_order_id, { line_items: updates });
    }
    throw new AppError('WooCommerce could not reproduce the agreed tax-inclusive wholesale price exactly. Leave the order unpaid and review tax settings.', 409, 'RECONCILIATION_REQUIRED');
  }
  saveRemote(row, order) {
    assertOrderIdentity(row, order);
    const total = money(order.total);
    const refunded = remoteRefunded(order);
    const paid = remotePaid(order);
    const currency = order.currency || this.config.currency;
    let status;
    let error = null;
    if (currency !== this.config.currency) {
      status = 'needs_reconciliation';
      error = `The connected store returned ${currency}, not ${this.config.currency}. Review the WooCommerce order before recording payment.`;
    } else if (paid) {
      status = refunded >= total && total > 0 ? 'refunded' : refunded > 0 ? 'partially_refunded' : 'paid';
    } else if (['cancelled', 'trash', 'failed'].includes(order.status)) {
      status = 'cancelled';
    } else {
      status = 'awaiting_payment';
    }
    let verified = row.trade_verified_json;
    if (row.sale_type === 'trade') {
      const problem = wholesaleOrderProblem(row, order);
      const snapshot = !problem ? wholesaleVerifiedSnapshot(order) : null;
      const mismatch = verified && snapshot && verified !== snapshot;
      const paymentProblem = wholesalePaymentProblem(row, order);
      if (problem || mismatch || paymentProblem || (paid && !verified)) {
        status = 'needs_reconciliation';
        error = problem || (mismatch ? 'WooCommerce line tax or net amount changed after the approved wholesale quote was verified. Review the order.' : paymentProblem || 'The wholesale quote was not verified before payment. Review the order.');
      } else if (status === 'awaiting_payment' && !verified) {
        verified = snapshot;
      }
    }
    const items = (order.line_items || []).map(item => {
      const original = JSON.parse(row.items_json || '[]').find(i => i.productId === item.product_id && i.variationId === (item.variation_id || 0));
      return { productId: item.product_id, variationId: item.variation_id || 0, name: item.name, label: item.meta_data?.find(m => ['Size', 'size'].includes(m.key))?.value || original?.label || '', sku: item.sku || '', image: original?.image || '', price: money(item.price), quantity: item.quantity, total: money(item.total), tax: money(item.total_tax) };
    });
    this.db.prepare('UPDATE sales SET woo_order_id=?,number=?,status=?,total=?,tax=?,subtotal=?,refunded=?,currency=?,items_json=?,trade_verified_json=?,prepared_total=?,updated_at=?,paid_at=?,error=? WHERE id=?')
      .run(order.id, `${this.config.mode === 'live' ? 'WC' : 'STG'}-${order.number || order.id}`, status, total, money(order.total_tax), (order.line_items || []).reduce((sum, i) => sum + money(i.subtotal), 0), refunded, currency, JSON.stringify(items), verified,
        row.sale_type === 'trade' && verified && !row.prepared_total ? total : row.prepared_total, now(), paid ? remotePaidAt(order) : null, error, row.id);
    if (paid || isSettled(status)) this.catalog.invalidate();
    return this.get(row.id, { role: 'owner' });
  }
  async recoverExisting(user, existing) {
    if (this.config.mode === 'demo') throw new AppError('This demo checkout needs review before another attempt.', 409, 'RECONCILIATION_REQUIRED');
    try {
      const recovered = await this.reconcile(user, existing.id);
      if (recovered.status === 'awaiting_payment' || isSettled(recovered.status)) return recovered;
      if (recovered.status === 'cancelled') throw new AppError('The previous checkout was cancelled. Start a new sale.', 409, 'CHECKOUT_CLOSED');
      throw new AppError('This sale needs reconciliation before another attempt.', 409, 'RECONCILIATION_REQUIRED');
    } catch (error) {
      if (error instanceof AppError && ['CHECKOUT_CLOSED', 'RECONCILIATION_REQUIRED'].includes(error.code)) throw error;
      throw new AppError('Checkout was interrupted. Do not create another order; reconcile this sale from Sales first.', 502, 'RECONCILIATION_REQUIRED');
    }
  }
  async prepare(user, input) {
    if (this.config.mode !== 'demo' && !this.config.writesEnabled) throw new AppError('Checkout is locked. Complete the documented acceptance checks and approved server-side write gate first.', 403, 'CHECKOUT_LOCKED');
    const saleType = input.saleType || 'retail';
    if (saleType === 'wholesale' && !['owner', 'manager'].includes(user.role)) throw new AppError('Only an owner or manager can agree a wholesale price.', 403, 'WHOLESALE_ROLE_REQUIRED');
    if (saleType === 'wholesale' && !this.config.wholesaleWritesEnabled) throw new AppError('Wholesale checkout is locked. Live sales require separately documented tax/total acceptance and written owner approval.', 403, 'WHOLESALE_CHECKOUT_LOCKED');
    const items = normalizeItems(input.items);
    const buyer = saleType === 'wholesale' && input.buyerId ? this.db.prepare('SELECT id,name FROM trade_buyers WHERE id=?').get(input.buyerId) : null;
    if (input.buyerId && !buyer) throw new AppError('That saved wholesale buyer no longer exists. Review Sales before retrying.', 400);
    const buyerName = buyer?.name || (saleType === 'wholesale' ? (input.buyerName || '').replace(/\s+/g, ' ') : '');
    const agreedTotal = saleType === 'wholesale' ? items.reduce((sum, item) => sum + item.agreedUnitPrice * item.quantity, 0) : 0;
    if (saleType === 'wholesale' && (!Number.isSafeInteger(agreedTotal) || agreedTotal < 1 || agreedTotal > 100000000)) throw new AppError('The agreed wholesale total must be between GH₵0.01 and GH₵1,000,000.00.', 400);
    const hash = fingerprint(items, input.note, saleType, buyer?.id, buyerName);
    const cartSignature = saleType === 'wholesale'
      ? JSON.stringify(items.map(({ productId, variationId, quantity }) => ({ productId, variationId, quantity }))) : '';
    const prepareOrder = () => this.exclusive(`prepare:${input.idempotencyKey}`, async () => {
      const existing = this.db.prepare('SELECT * FROM sales WHERE idempotency_key=?').get(input.idempotencyKey);
      if (existing) {
        if (existing.fingerprint !== hash || existing.cashier_id !== user.id) throw new AppError('This checkout key belongs to a different cart.', 409);
        if (existing.status === 'awaiting_payment' || isSettled(existing.status)) return saleView(existing);
        if (['cancelled', 'failed'].includes(existing.status)) throw new AppError('The previous checkout is closed. Adjust the cart to start a new sale.', 409, 'CHECKOUT_CLOSED');
        return this.recoverExisting(user, existing);
      }
      const recentDuplicate = this.db.prepare(`SELECT id FROM sales WHERE cashier_id=? AND fingerprint=? AND status IN ('creating','needs_reconciliation','awaiting_payment') AND created_at>=? ORDER BY created_at DESC LIMIT 1`)
        .get(user.id, hash, new Date(Date.now() - RECOVERY_WINDOW_MS).toISOString());
      if (recentDuplicate) throw new AppError('An unpaid checkout for this cart already exists. Review Sales before creating another order.', 409, 'RECONCILIATION_REQUIRED');
      if (saleType === 'wholesale') {
        // After an uncertain response the name, approver, price and note can
        // all change. Do not create another Woo order with the same goods while
        // ANY matching wholesale quote remains pending, even after 15 minutes.
        const pending = this.db.prepare(`SELECT trade_quote_json FROM sales WHERE sale_type='trade' AND status IN ('creating','needs_reconciliation','awaiting_payment')`).all();
        if (pending.some(row => JSON.stringify(JSON.parse(row.trade_quote_json || '[]').map(({ productId, variationId, quantity }) => ({ productId, variationId, quantity }))) === cartSignature)) {
          throw new AppError('An unpaid wholesale order for these goods may already exist. Review or resolve it in Sales before creating another order, even for a different buyer.', 409, 'RECONCILIATION_REQUIRED');
        }
      }
      const shift = this.config.requireShift && this.config.mode !== 'demo' ? this.shifts.requireOpen(user.id) : this.shifts.current(user.id);
      const id = randomUUID();
      const time = now();
      const number = `DEMO-${id.slice(0, 8).toUpperCase()}`;
      this.db.prepare('INSERT INTO sales(id,idempotency_key,fingerprint,number,status,currency,cashier_id,cashier_name,note,created_at,updated_at,shift_id,sale_type,buyer_id,buyer_name,trade_quote_json,trade_approved_by_id,trade_approved_by_name,trade_approved_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, input.idempotencyKey, hash, number, 'creating', this.config.currency, user.id, user.name, input.note, time, time, shift?.id || null,
          // v4 has a `trade` CHECK constraint. Map the replacement workflow to
          // that durable legacy discriminator so existing ledgers never lose data.
          saleType === 'wholesale' ? 'trade' : 'retail', buyer?.id || null, buyerName, saleType === 'wholesale' ? JSON.stringify(items) : null,
          saleType === 'wholesale' ? user.id : null, saleType === 'wholesale' ? user.name : null, saleType === 'wholesale' ? time : null);
      try {
        const lines = await this.catalog.fresh(items);
        validateAvailability(lines);
        const quote = saleType === 'wholesale' ? items.map((item, index) => ({ ...item, catalogueUnitPrice: lines[index].price })) : null;
        if (quote?.some(item => !Number.isSafeInteger(item.catalogueUnitPrice) || item.catalogueUnitPrice < 0)) {
          throw new AppError('The current catalogue price could not be verified. Refresh the product before preparing a wholesale order.', 409);
        }
        const draft = lines.map(line => ({ productId: line.productId, variationId: line.variationId, quantity: line.quantity,
          name: line.name, label: line.label, sku: line.sku, image: line.image, price: line.price, cataloguePrice: line.price }));
        // Save the catalogue snapshot and agreement before any remote write, so
        // an interrupted Woo response still has the exact approved terms.
        this.db.prepare('UPDATE sales SET items_json=?,trade_quote_json=? WHERE id=?').run(JSON.stringify(draft), quote ? JSON.stringify(quote) : null, id);
        if (this.config.mode === 'demo') {
          const agreed = new Map(quote?.map(item => [lineKey(item), item.agreedUnitPrice]));
          const savedLines = draft.map(line => ({ ...line, total: (saleType === 'wholesale' ? agreed.get(lineKey(line)) : line.price) * line.quantity, tax: 0 }));
          const total = savedLines.reduce((sum, line) => sum + line.total, 0);
          this.db.prepare('UPDATE sales SET status=?,total=?,prepared_total=?,subtotal=?,items_json=? WHERE id=?').run('awaiting_payment', total, total, total, JSON.stringify(savedLines), id);
        } else {
          const row = this.get(id, user);
          const meta = [{ key: '_mansu_pos_key', value: input.idempotencyKey }, { key: '_mansu_pos_channel', value: 'mansu-pos' }, { key: '_mansu_pos_cashier', value: user.id }];
          if (quote) meta.push(
            { key: '_mansu_pos_sale_type', value: 'wholesale' },
            ...(buyer?.id ? [{ key: '_mansu_pos_wholesale_buyer_id', value: buyer.id }] : []),
            ...(buyerName ? [{ key: '_mansu_pos_wholesale_buyer', value: buyerName }] : []),
            { key: '_mansu_pos_wholesale_approver', value: user.id },
            { key: '_mansu_pos_wholesale_approver_name', value: user.name },
            { key: '_mansu_pos_wholesale_approved_at', value: time },
            { key: '_mansu_pos_quote_hash', value: quoteHash(row, quote) },
          );
          const created = await this.api.createOrder({
            status: 'pending', payment_method: '', payment_method_title: 'In-store payment pending',
            ...(buyerName ? { billing: { first_name: buyerName } } : {}),
            line_items: items.map((i, index) => ({ product_id: i.productId, ...(i.variationId ? { variation_id: i.variationId } : {}), quantity: i.quantity,
              ...(quote ? { meta_data: [
                { key: 'Mansu agreed unit gross (GHS)', value: asDecimal(quote[index].agreedUnitPrice) },
                { key: 'Mansu catalogue unit (GHS)', value: asDecimal(quote[index].catalogueUnitPrice) },
              ] } : {}) })),
            shipping: [], customer_note: input.note, meta_data: meta,
          });
          this.db.prepare('UPDATE sales SET woo_order_id=? WHERE id=?').run(created.id, id);
          const order = saleType === 'wholesale' ? await this.repriceWholesaleOrder(this.get(id, user), created) : created;
          const saved = this.saveRemote(this.get(id, user), order);
          if (saved.status !== 'awaiting_payment') throw new AppError(saved.error || 'WooCommerce did not return a payable pending order. Review Sales before retrying.', 409, 'RECONCILIATION_REQUIRED');
          if (saleType !== 'wholesale') this.db.prepare('UPDATE sales SET prepared_total=? WHERE id=?').run(saved.total, id);
        }
        audit(this.db, user.id, saleType === 'wholesale' ? 'sale.wholesale_prepared' : 'sale.prepared', id);
        return saleView(this.get(id, user));
      } catch (error) {
        const mayExistRemotely = Boolean(this.get(id, user).woo_order_id);
        this.db.prepare('UPDATE sales SET status=?,error=?,updated_at=? WHERE id=?').run(error.uncertain || mayExistRemotely ? 'needs_reconciliation' : 'failed', error.message, now(), id);
        if (error instanceof AppError && !error.uncertain && !mayExistRemotely) throw error;
        throw new AppError('Checkout was interrupted. Do not create another order; reconcile this sale from Sales first.', 502, 'RECONCILIATION_REQUIRED');
      }
    });
    // Serialize matching goods across names and approvers as well as keys,
    // so simultaneous submissions cannot race past the pending-order check.
    return saleType === 'wholesale' ? this.exclusive(`wholesale-cart:${cartSignature}`, prepareOrder) : prepareOrder();
  }
  async complete(user, id, payment) {
    return this.exclusive(`sale:${id}`, async () => {
      const row = this.get(id, user);
      if (!this.config.paymentMethods.includes(payment.method)) {
        throw new AppError('Live POS payments are cash-only. Do not record MoMo or card as a cash sale.', 403, 'PAYMENT_METHOD_LOCKED');
      }
      if (isSettled(row.status)) return saleView(row);
      if (this.config.mode !== 'demo' && !this.config.writesEnabled) throw new AppError('Checkout writes are locked. Do not collect payment or release goods.', 403, 'CHECKOUT_LOCKED');
      if (row.sale_type === 'trade' && !this.config.wholesaleWritesEnabled) throw new AppError('Wholesale checkout is locked. Do not collect payment or release goods.', 403, 'WHOLESALE_CHECKOUT_LOCKED');
      if (row.status !== 'awaiting_payment') throw new AppError('This sale is not ready to record payment. Reconcile or review it first.', 409);
      if (this.config.requireShift && this.config.mode !== 'demo') {
        const shift = row.shift_id ? this.db.prepare('SELECT status FROM shifts WHERE id=?').get(row.shift_id) : null;
        if (!shift || shift.status !== 'open') throw new AppError('The shift for this sale is closed. Ask an owner to review it before recording payment.', 409, 'SHIFT_CLOSED');
      }
      const total = row.total;
      if (payment.method === 'cash' && (payment.tendered == null || payment.tendered < total)) throw new AppError('Cash received must cover the WooCommerce order total.', 400);
      const tendered = payment.method === 'cash' ? payment.tendered : total;
      const reference = payment.method === 'cash' ? '' : payment.reference;
      const finish = () => {
        this.db.prepare('UPDATE sales SET status=?,payment_method=?,payment_reference=?,tendered=?,change_due=?,paid_at=?,updated_at=?,error=NULL WHERE id=?')
          .run('paid', payment.method, reference, tendered, tendered - total, now(), now(), id);
        audit(this.db, user.id, 'sale.paid', `${id}:${payment.method}`);
        return saleView(this.get(id, user));
      };
      if (this.config.mode === 'demo') {
        this.db.exec('BEGIN IMMEDIATE');
        try {
          for (const item of JSON.parse(row.items_json)) {
            const key = `${item.productId}:${item.variationId || 0}`;
            const stock = this.db.prepare('SELECT stock FROM demo_stock WHERE line_key=?').get(key);
            if (!stock || stock.stock < item.quantity) throw new AppError(`Demo stock changed for ${item.name}. Prepare a new sale.`, 409);
            this.db.prepare('UPDATE demo_stock SET stock=stock-? WHERE line_key=?').run(item.quantity, key);
          }
          const result = finish();
          this.db.exec('COMMIT');
          return result;
        } catch (error) { this.db.exec('ROLLBACK'); throw error; }
      }
      try {
        if (!row.woo_order_id) throw new AppError('This sale has no WooCommerce order to pay.', 409, 'RECONCILIATION_REQUIRED');
        const current = await this.api.order(row.woo_order_id);
        assertOrderIdentity(row, current);
        if (current.currency !== this.config.currency) {
          this.saveRemote(row, current);
          throw new AppError(`The connected store returned ${current.currency}, not ${this.config.currency}. Reconcile this sale before recording payment.`, 409, 'RECONCILIATION_REQUIRED');
        }
        if (['cancelled', 'trash', 'failed'].includes(current.status)) {
          this.saveRemote(row, current);
          throw new AppError('WooCommerce shows this order as cancelled or failed. Do not record payment against it.', 409, 'ORDER_CANCELLED');
        }
        const currentTotal = money(current.total);
        if (currentTotal !== total) {
          this.saveRemote(row, current);
          this.db.prepare('UPDATE sales SET status=?,error=?,updated_at=? WHERE id=?').run('needs_reconciliation', `WooCommerce total changed from ${(total / 100).toFixed(2)} to ${(currentTotal / 100).toFixed(2)}. Review the order before recording payment.`, now(), id);
          throw new AppError('The WooCommerce total changed after preparation. Reconcile this sale before recording payment.', 409, 'TOTAL_CHANGED');
        }
        if (row.sale_type === 'trade' && (current.status !== 'pending' || !row.trade_verified_json ||
          wholesaleOrderProblem(row, current) || wholesaleVerifiedSnapshot(current) !== row.trade_verified_json || cents(current.total_tax) !== row.tax)) {
          this.saveRemote(row, current);
          throw new AppError('The wholesale order changed after price approval. Do not collect payment; reconcile it first.', 409, 'WHOLESALE_QUOTE_CHANGED');
        }
        validateAvailability(await this.catalog.fresh(JSON.parse(row.items_json).map(i => ({ productId: i.productId, variationId: i.variationId, quantity: i.quantity }))));
        if (payment.method === 'cash' && payment.tendered < currentTotal) throw new AppError('Cash received must cover the WooCommerce order total.', 400);
        // Persist the intended payment record before the remote write so a lost response can be reconciled.
        this.db.prepare('UPDATE sales SET payment_method=?,payment_reference=?,tendered=?,change_due=? WHERE id=?').run(payment.method, reference, tendered, tendered - currentTotal, id);
        if (remotePaid(current)) {
          const saved = this.saveRemote(this.get(id, user), current);
          if (!isSettled(saved.status)) throw new AppError('WooCommerce payment state needs review.', 409, 'RECONCILIATION_REQUIRED');
          audit(this.db, user.id, 'sale.paid', `${id}:${payment.method}`);
          return saleView(saved);
        }
        const order = await this.api.updateOrder(row.woo_order_id, {
          status: this.config.orderStatus, set_paid: true,
          payment_method: methodCodes[payment.method], payment_method_title: methodNames[payment.method],
          transaction_id: reference,
          meta_data: [{ key: '_mansu_pos_payment_recorded', value: 'externally-collected' }, { key: '_mansu_pos_paid_at', value: now() }],
        });
        assertOrderIdentity(row, order);
        const saved = this.saveRemote(this.get(id, user), order);
        if (saved.currency !== this.config.currency || saved.total !== currentTotal || (payment.method === 'cash' && saved.tendered < saved.total)) {
          this.db.prepare('UPDATE sales SET status=?,error=?,updated_at=? WHERE id=?').run('needs_reconciliation', 'WooCommerce changed the order during payment confirmation. Owner must review the remote order before taking further payment.', now(), id);
          throw new AppError('Payment confirmation needs reconciliation. Do not collect a second payment or create a new order.', 502, 'RECONCILIATION_REQUIRED');
        }
        if (!isSettled(saved.status)) throw new AppError('WooCommerce has not confirmed payment. Reconcile this sale before retrying.', 409, 'RECONCILIATION_REQUIRED');
        audit(this.db, user.id, 'sale.paid', `${id}:${payment.method}`);
        return saleView(saved);
      } catch (error) {
        const status = error.code === 'ORDER_CANCELLED' ? 'cancelled' : 'needs_reconciliation';
        this.db.prepare('UPDATE sales SET status=?,error=?,updated_at=? WHERE id=?').run(status, error.message || 'Payment confirmation was interrupted. Check the WooCommerce order before taking another payment.', now(), id);
        if (error instanceof AppError && ['TOTAL_CHANGED', 'ORDER_CANCELLED', 'WHOLESALE_QUOTE_CHANGED'].includes(error.code)) throw error;
        if (error instanceof AppError && !error.uncertain && error.code !== 'WOOCOMMERCE_ERROR' && error.code !== 'RECONCILIATION_REQUIRED') throw error;
        throw new AppError('Payment confirmation needs reconciliation. Do not collect a second payment or create a new order.', 502, 'RECONCILIATION_REQUIRED');
      }
    });
  }
  async reconcile(user, id) {
    return this.exclusive(`sale:${id}`, async () => {
      const row = this.get(id, user);
      if (this.config.mode === 'demo') throw new AppError('Demo sales do not connect to WooCommerce.', 400);
      try {
        const order = row.woo_order_id ? await this.api.order(row.woo_order_id) : await this.api.findOrderByKey(row.idempotency_key, row.created_at);
        if (!order) {
          this.db.prepare('UPDATE sales SET status=?,error=?,updated_at=? WHERE id=?').run('needs_reconciliation', 'No matching WooCommerce order found in the recent search window. Owner must verify in WooCommerce before retrying.', now(), id);
          throw new AppError('No matching order found. Do not retry checkout until the owner has verified WooCommerce.', 409, 'RECONCILIATION_REQUIRED');
        }
        assertOrderIdentity(row, order);
        const saved = saleView(this.saveRemote(row, order));
        audit(this.db, user.id, 'sale.reconciled', id);
        return saved;
      } finally {
        this.markReconcileAttempt(id);
      }
    });
  }
  async reconcilePending(user = { id: 'system', role: 'owner', name: 'System' }, limit = 20) {
    if (this.config.mode === 'demo' || !this.config.configured) return { checked: 0, reconciled: 0, failed: 0 };
    const paidBefore = new Date(Date.now() - 3600000).toISOString();
    const cooldown = new Date(Date.now() - 30000).toISOString();
    const rows = this.db.prepare(`SELECT id FROM sales WHERE (
        status IN ('creating','needs_reconciliation','awaiting_payment')
        OR (status IN ('paid','partially_refunded','refunded') AND updated_at < ?)
      ) AND (last_reconciled_at IS NULL OR last_reconciled_at < ?)
      ORDER BY CASE WHEN status='needs_reconciliation' THEN 0 WHEN status='creating' THEN 1 WHEN status='awaiting_payment' THEN 2 ELSE 3 END,
        COALESCE(last_reconciled_at,'0000') ASC, updated_at ASC LIMIT ?`)
      .all(paidBefore, cooldown, limit);
    let reconciled = 0, failed = 0;
    for (const row of rows) {
      try { await this.reconcile(user, row.id); reconciled++; }
      catch { failed++; }
    }
    if (rows.length) audit(this.db, user.id, 'sale.reconcile_pending', `checked=${rows.length};reconciled=${reconciled};failed=${failed}`);
    return { checked: rows.length, reconciled, failed };
  }
  async cancel(user, id) {
    return this.exclusive(`sale:${id}`, async () => {
      const row = this.get(id, user);
      if (row.status === 'cancelled') return saleView(row);
      if (!['awaiting_payment', 'failed'].includes(row.status)) throw new AppError('Only an unpaid, known order can be cancelled here. Handle paid orders and refunds in WooCommerce.', 409);
      // Cancelling a pending Woo order is itself a remote write. Closing either
      // gate must not leave a path that still mutates the store.
      if (this.config.mode !== 'demo' && !this.config.writesEnabled) throw new AppError('WooCommerce writes are locked. Ask the owner to review the unpaid order in WooCommerce.', 403, 'CHECKOUT_LOCKED');
      if (row.sale_type === 'trade' && !this.config.wholesaleWritesEnabled) throw new AppError('Wholesale writes are locked. Ask the owner to review the unpaid order in WooCommerce.', 403, 'WHOLESALE_CHECKOUT_LOCKED');
      if (this.config.mode !== 'demo' && row.woo_order_id) {
        try {
          const current = await this.api.order(row.woo_order_id);
          assertOrderIdentity(row, current);
          if (remotePaid(current)) {
            this.saveRemote(row, current);
            throw new AppError('WooCommerce shows this order as paid. Handle refunds in WooCommerce instead of cancelling.', 409, 'ORDER_ALREADY_PAID');
          }
          if (current.status !== 'cancelled') {
            const cancelled = await this.api.updateOrder(row.woo_order_id, { status: 'cancelled' });
            assertOrderIdentity(row, cancelled);
            this.saveRemote(row, cancelled);
          } else {
            this.saveRemote(row, current);
          }
        } catch (error) {
          if (error instanceof AppError && error.code === 'ORDER_ALREADY_PAID') throw error;
          this.db.prepare('UPDATE sales SET status=?,error=?,updated_at=? WHERE id=?').run('needs_reconciliation', 'Cancellation was interrupted. Reconcile the WooCommerce order before taking payment or creating another order.', now(), id);
          throw new AppError('Cancellation needs reconciliation. Do not record payment against this sale until the remote order is verified.', 502, 'RECONCILIATION_REQUIRED');
        }
      }
      this.db.prepare('UPDATE sales SET status=?,updated_at=?,error=NULL WHERE id=?').run('cancelled', now(), id);
      audit(this.db, user.id, 'sale.cancelled', id);
      return saleView(this.get(id, user));
    });
  }
}
