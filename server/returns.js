import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError, RemoteError, now } from './errors.js';
import { audit, saleView } from './db.js';
import { saleEvent } from './sale-events.js';

// Customer returns against a POS sale.
//
// One return does, in order:
//   1. a manual (cash) refund on the original WooCommerce order, with Woo's
//      own restocking OFF so stock is never added twice;
//   2. a Cash out on the staff member's open shift for the cash paid back;
//   3. for each line, the chosen disposition. Only "restock" adds units to
//      WooCommerce stock (through Stock control); damaged / quarantine lines
//      wait in "Awaiting decision" until an owner or manager resolves them.
// A request key makes a retried return finish only what is left, never
// refund or restock twice. Records here are POS-side; the Woo order shows the refund.

export const DISPOSITIONS = ['restock', 'damaged', 'quarantine', 'write_off', 'supplier_return'];
export const DISPOSITION_LABELS = {
  restock: 'Back on sale', damaged: 'Damaged', quarantine: 'Check first', write_off: 'Written off', supplier_return: 'Return to supplier',
};
const line = max => z.string().trim().max(max).refine(v => !/[\r\n\0]/.test(v), 'Use one line');
export const returnSchema = z.object({
  key: z.string().uuid(), saleId: z.string().min(1).max(80),
  reason: z.enum(['wrong_size', 'faulty', 'damaged_in_shop', 'changed_mind', 'price_error', 'other']), note: line(200).default(''),
  lines: z.array(z.object({
    productId: z.number().int().positive(), variationId: z.number().int().min(0).default(0),
    quantity: z.number().int().min(1).max(999), disposition: z.enum(DISPOSITIONS),
  }).strict()).min(1).max(50),
}).strict().superRefine((value, ctx) => {
  if (value.reason === 'other' && value.note.length < 3) ctx.addIssue({ code: 'custom', path: ['note'], message: 'Describe the reason' });
  const seen = new Set();
  value.lines.forEach((l, i) => { const k = `${l.productId}:${l.variationId}`; if (seen.has(k)) ctx.addIssue({ code: 'custom', path: ['lines', i], message: 'Each item once per return' }); seen.add(k); });
});
export const resolveSchema = z.object({ action: z.enum(['restock', 'write_off', 'supplier_return']), note: line(200).default('') }).strict();
export const REASON_LABELS = { wrong_size: 'Wrong size', faulty: 'Faulty', damaged_in_shop: 'Damaged in shop', changed_mind: 'Changed mind', price_error: 'Price error', other: 'Other' };

export function returnsWriteState(config, inventoryState) {
  if (config.liveReadOnly) return { enabled: false, reason: 'The read-only live pilot cannot record returns.' };
  if (config.mode === 'demo') return { enabled: true, reason: 'Demo: refunds and stock are practice data only.' };
  if (config.onlineBridgeEnabled || config.onlineBridgeQuarantined) return { enabled: false, reason: 'Returns are locked while the reservation bridge profile is active or under review.' };
  if (!config.writesEnabled) return { enabled: false, reason: 'WooCommerce writes are not approved for this POS service.' };
  if (!inventoryState.enabled) return { enabled: false, reason: `Returns need Stock control writes: ${inventoryState.reason}` };
  if (!config.returnsEnabled) return { enabled: false, reason: 'Customer returns are switched off. Set POS_RETURNS_APPROVED=true on the trading service to enable them.' };
  return { enabled: true, reason: 'The refund is recorded on the WooCommerce order and the cash on your shift.' };
}

export class ReturnsService {
  constructor(db, api, inventory, shifts, config) {
    this.db = db; this.api = api; this.inventory = inventory; this.shifts = shifts; this.config = config;
    this.queue = Promise.resolve();
    db.exec(`
      CREATE TABLE IF NOT EXISTS customer_returns (id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, number TEXT NOT NULL UNIQUE, sale_id TEXT NOT NULL REFERENCES sales(id),
        woo_order_id INTEGER, woo_refund_id INTEGER, status TEXT NOT NULL, refund_total INTEGER NOT NULL CHECK(refund_total >= 0), payment_method TEXT, shift_id TEXT, cash_recorded INTEGER NOT NULL DEFAULT 0,
        reason TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL, created_by_name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, error TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS customer_return_items (id TEXT PRIMARY KEY, return_id TEXT NOT NULL REFERENCES customer_returns(id), product_id INTEGER NOT NULL, variation_id INTEGER NOT NULL DEFAULT 0,
        name TEXT NOT NULL, label TEXT NOT NULL DEFAULT '', sku TEXT NOT NULL DEFAULT '', quantity INTEGER NOT NULL CHECK(quantity > 0), unit_refund INTEGER NOT NULL CHECK(unit_refund >= 0),
        disposition TEXT NOT NULL, stock_status TEXT NOT NULL DEFAULT 'pending', stock_before INTEGER, stock_after INTEGER,
        resolution TEXT, resolved_by_name TEXT, resolved_at TEXT, resolution_note TEXT NOT NULL DEFAULT '', UNIQUE(return_id, product_id, variation_id));
      CREATE INDEX IF NOT EXISTS idx_returns_sale ON customer_returns(sale_id);
      CREATE INDEX IF NOT EXISTS idx_return_items_open ON customer_return_items(disposition, resolution);
      CREATE TRIGGER IF NOT EXISTS customer_returns_no_delete BEFORE DELETE ON customer_returns BEGIN SELECT RAISE(ABORT,'Customer returns cannot be deleted'); END;
      CREATE TRIGGER IF NOT EXISTS customer_return_items_no_delete BEFORE DELETE ON customer_return_items BEGIN SELECT RAISE(ABORT,'Customer return lines cannot be deleted'); END;
      CREATE TRIGGER IF NOT EXISTS customer_return_items_resolve_once BEFORE UPDATE OF resolution ON customer_return_items WHEN OLD.resolution IS NOT NULL
        BEGIN SELECT RAISE(ABORT,'A return line can be resolved only once'); END;
    `);
  }
  state() { return returnsWriteState(this.config, this.inventory.writes()); }
  requireWrites() { const s = this.state(); if (!s.enabled) throw new AppError(s.reason, 403, 'RETURNS_LOCKED'); }
  exclusive(work) { const run = this.queue.then(work, work); this.queue = run.catch(() => {}); return run; }
  tx(work) { this.db.exec('BEGIN IMMEDIATE'); try { const r = work(); this.db.exec('COMMIT'); return r; } catch (e) { this.db.exec('ROLLBACK'); throw e; } }
  nextNumber() {
    const last = this.db.prepare("SELECT number FROM customer_returns ORDER BY number DESC LIMIT 1").get()?.number;
    return `RTN-${String((last ? Number(last.split('-')[1]) : 0) + 1).padStart(5, '0')}`;
  }

  // ---------- finding a sale ----------
  find(query) {
    const q = String(query || '').trim();
    const rows = q
      ? this.db.prepare("SELECT * FROM sales WHERE status IN ('paid','partially_refunded') AND (number LIKE ? OR CAST(woo_order_id AS TEXT)=?) ORDER BY created_at DESC LIMIT 20").all(`%${q.replace(/^#/, '')}%`, q.replace(/^#/, ''))
      : this.db.prepare("SELECT * FROM sales WHERE status IN ('paid','partially_refunded') ORDER BY COALESCE(paid_at,created_at) DESC LIMIT 20").all();
    return rows.map(r => { const s = saleView(r); return { id: s.id, number: s.number, total: s.total, refunded: s.refunded, paidAt: s.paidAt || s.createdAt, cashierName: s.cashierName, paymentMethod: s.paymentMethod, saleType: s.saleType, items: s.items.reduce((n, i) => n + i.quantity, 0) }; });
  }
  returnedBySale(saleId) {
    const map = new Map();
    for (const r of this.db.prepare(`SELECT i.product_id, i.variation_id, SUM(i.quantity) AS qty FROM customer_return_items i JOIN customer_returns r ON r.id=i.return_id
      WHERE r.sale_id=? AND r.status != 'failed' GROUP BY i.product_id, i.variation_id`).all(saleId)) map.set(`${r.product_id}:${r.variation_id}`, r.qty);
    return map;
  }
  saleForReturn(saleId) {
    const row = this.db.prepare('SELECT * FROM sales WHERE id=?').get(saleId);
    if (!row) throw new AppError('Sale not found.', 404);
    const sale = saleView(row);
    const returned = this.returnedBySale(saleId);
    // A loyalty points discount lowers what was actually paid: refund each
    // line in proportion, never more than the customer paid.
    const goods = sale.items.reduce((sum, i) => sum + (i.agreedLineTotal ?? i.total ?? i.price * i.quantity), 0);
    const share = goods > sale.total && sale.total > 0 ? sale.total / goods : 1;
    const lines = sale.items.map(i => {
      const paid = Math.floor((i.agreedLineTotal ?? i.total ?? i.price * i.quantity) * share);
      const key = `${i.productId}:${i.variationId || 0}`;
      return { productId: i.productId, variationId: i.variationId || 0, name: i.name, label: i.label || '', sku: i.sku || '', image: i.image || '',
        sold: i.quantity, returned: returned.get(key) || 0, returnable: Math.max(0, i.quantity - (returned.get(key) || 0)), unitRefund: Math.floor(paid / i.quantity) };
    });
    const shift = this.shifts.current(this._user?.id);
    return { sale: { id: sale.id, number: sale.number, status: sale.status, total: sale.total, refunded: sale.refunded, tax: sale.tax, paymentMethod: sale.paymentMethod,
      saleType: sale.saleType, paidAt: sale.paidAt || sale.createdAt, cashierName: sale.cashierName, wooOrderId: sale.wooOrderId }, lines,
      returns: this.list({ saleId }), refundable: ['paid', 'partially_refunded'].includes(sale.status), shiftOpen: Boolean(shift), shiftRequired: Boolean(this.config.requireShift), drawerCash: shift?.expectedCash ?? null };
  }
  forUser(user, saleId) { this._user = user; try { return this.saleForReturn(saleId); } finally { this._user = null; } }

  // ---------- recording a return ----------
  create(user, input) {
    this.requireWrites();
    return this.exclusive(() => this.process(user, input));
  }
  async process(user, input) {
    let ret = this.db.prepare('SELECT * FROM customer_returns WHERE idempotency_key=?').get(input.key);
    if (ret && ret.sale_id !== input.saleId) throw new AppError('This request belongs to a different sale.', 409);
    if (!ret) ret = await this.begin(user, input);
    if (ret.status === 'failed') throw new AppError(ret.error || 'This return failed. Start a new return.', 409, 'RETURN_FAILED');
    if (ret.status === 'refunding') ret = await this.refund(user, ret);
    if (ret.status === 'refunded') ret = this.recordCash(user, ret);
    const failures = ret.status === 'completed' || ret.status === 'cash_review' ? await this.applyStock(user, ret) : [];
    return { return: this.view(this.db.prepare('SELECT * FROM customer_returns WHERE id=?').get(ret.id)), failures };
  }
  async begin(user, input) {
    const sale = this.db.prepare('SELECT * FROM sales WHERE id=?').get(input.saleId);
    if (!sale) throw new AppError('Sale not found.', 404);
    if (!['paid', 'partially_refunded'].includes(sale.status)) throw new AppError('Only a paid sale can be returned. Review this sale first.', 409, 'SALE_NOT_RETURNABLE');
    if (this.config.mode !== 'demo' && !sale.woo_order_id) throw new AppError('This sale has no WooCommerce order to refund.', 409);
    if (this.config.mode !== 'demo' && sale.tax > 0) throw new AppError('This sale includes tax. Refund it in WooCommerce so the tax is split correctly, then record the cash out on your shift.', 409, 'TAXED_SALE');
    const info = this.forUser(user, sale.id);
    const chosen = input.lines.map(l => {
      const soldLine = info.lines.find(x => x.productId === l.productId && x.variationId === l.variationId);
      if (!soldLine) throw new AppError('A returned item was not part of this sale.', 400);
      if (l.quantity > soldLine.returnable) throw new AppError(`${soldLine.name}${soldLine.label ? ` (${soldLine.label})` : ''}: only ${soldLine.returnable} of ${soldLine.sold} can still be returned.`, 409, 'RETURN_EXCEEDS_SALE');
      return { ...soldLine, quantity: l.quantity, disposition: l.disposition };
    });
    let total = chosen.reduce((s, l) => s + l.unitRefund * l.quantity, 0);
    total = Math.min(total, Math.max(0, sale.total - sale.refunded));
    const cash = sale.payment_method === 'cash';
    let shift = null;
    if (cash && total > 0) {
      shift = this.shifts.current(user.id);
      if (!shift && this.config.requireShift) throw new AppError('Open your shift first: the refund is paid from your drawer.', 409, 'SHIFT_REQUIRED');
      if (shift && shift.expectedCash < total) throw new AppError(`Your drawer should hold ${(shift.expectedCash / 100).toFixed(2)} but the refund is ${(total / 100).toFixed(2)}. Add cash (Cash in) or use the owner's float first.`, 409, 'DRAWER_SHORT');
    }
    const id = randomUUID();
    const time = now();
    return this.tx(() => {
      this.db.prepare(`INSERT INTO customer_returns(id,idempotency_key,number,sale_id,woo_order_id,status,refund_total,payment_method,shift_id,reason,note,created_by,created_by_name,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, input.key, this.nextNumber(), sale.id, sale.woo_order_id, 'refunding', total, sale.payment_method, shift?.id || null,
        input.reason, input.note, user.id, user.name, time, time);
      const add = this.db.prepare('INSERT INTO customer_return_items(id,return_id,product_id,variation_id,name,label,sku,quantity,unit_refund,disposition) VALUES (?,?,?,?,?,?,?,?,?,?)');
      for (const l of chosen) add.run(randomUUID(), id, l.productId, l.variationId, l.name, l.label, l.sku, l.quantity, l.unitRefund, l.disposition);
      audit(this.db, user.id, 'return.started', id);
      return this.db.prepare('SELECT * FROM customer_returns WHERE id=?').get(id);
    });
  }
  async refund(user, ret) {
    const items = this.db.prepare('SELECT * FROM customer_return_items WHERE return_id=?').all(ret.id);
    const reasonText = `POS return ${ret.number} — ${REASON_LABELS[ret.reason]}${ret.note ? `: ${ret.note}` : ''} — by ${user.name}`.slice(0, 250);
    let refundId = null;
    if (this.config.mode !== 'demo' && ret.refund_total > 0) {
      try {
        // Retrying: adopt a refund that already reached Woo instead of refunding again.
        const existing = (await this.api.refunds(ret.woo_order_id) || []).find(r => String(r.reason || '').includes(`POS return ${ret.number} `));
        if (existing) refundId = existing.id;
        else {
          const order = await this.api.order(ret.woo_order_id);
          const lineItems = items.map(i => {
            const wooLine = (order.line_items || []).find(l => l.product_id === i.product_id && (l.variation_id || 0) === i.variation_id);
            if (!wooLine) throw new AppError(`${i.name} is no longer on the WooCommerce order. Refund it in WooCommerce.`, 409);
            return { id: wooLine.id, quantity: i.quantity, refund_total: (i.unit_refund * i.quantity / 100).toFixed(2), refund_tax: [] };
          });
          const created = await this.api.createRefund(ret.woo_order_id, { amount: (ret.refund_total / 100).toFixed(2), reason: reasonText, line_items: lineItems, api_refund: false, api_restock: false });
          refundId = Number(created?.id) || null;
        }
      } catch (error) {
        const definite = error instanceof AppError && !(error instanceof RemoteError) || (error instanceof RemoteError && error.wooStatus >= 400 && error.wooStatus < 500);
        this.tx(() => {
          this.db.prepare('UPDATE customer_returns SET status=?,error=?,updated_at=? WHERE id=?').run(definite ? 'failed' : 'refunding', String(error.wooMessage || error.message).slice(0, 200), now(), ret.id);
          audit(this.db, user.id, definite ? 'return.failed' : 'return.refund_unconfirmed', ret.id);
        });
        if (definite) throw new AppError(`WooCommerce did not accept the refund: ${error.wooMessage || error.message} Nothing was refunded or restocked.`, 409, 'REFUND_REJECTED');
        throw new AppError('WooCommerce did not confirm the refund. Press "Complete return" again: the POS checks the order first, so it never refunds twice.', 502, 'REFUND_UNCONFIRMED');
      }
    }
    const saved = this.tx(() => {
      const sale = this.db.prepare('SELECT * FROM sales WHERE id=?').get(ret.sale_id);
      const refunded = Math.min(sale.total, sale.refunded + ret.refund_total);
      this.db.prepare('UPDATE sales SET refunded=?,status=?,updated_at=? WHERE id=?').run(refunded, refunded >= sale.total ? 'refunded' : 'partially_refunded', now(), sale.id);
      this.db.prepare("UPDATE customer_returns SET status='refunded',woo_refund_id=?,error='',updated_at=? WHERE id=?").run(refundId, now(), ret.id);
      saleEvent(this.db, sale.id, 'return.refunded', user.id, { wooOrderId: sale.woo_order_id || null, amountCents: ret.refund_total,
        details: { returnNumber: ret.number, wooRefundId: refundId, method: ret.payment_method, shiftId: ret.shift_id } });
      audit(this.db, user.id, 'return.refunded', `${ret.id}:${ret.refund_total}`);
      return this.db.prepare('SELECT * FROM customer_returns WHERE id=?').get(ret.id);
    });
    // Take back the loyalty points earned on the refunded amount.
    try { this.customers?.onReturn(ret.sale_id, ret.id, ret.refund_total, user.id); } catch { /* owner can adjust points */ }
    return saved;
  }
  recordCash(user, ret) {
    if (ret.payment_method !== 'cash' || ret.refund_total === 0 || !ret.shift_id) {
      return this.tx(() => { this.db.prepare("UPDATE customer_returns SET status='completed',updated_at=? WHERE id=?").run(now(), ret.id); return this.db.prepare('SELECT * FROM customer_returns WHERE id=?').get(ret.id); });
    }
    try {
      this.shifts.movement(user, ret.shift_id, { type: 'out', amount: ret.refund_total, reason: `Refund ${ret.number} (sale ${this.db.prepare('SELECT number FROM sales WHERE id=?').get(ret.sale_id).number})` });
      return this.tx(() => { this.db.prepare("UPDATE customer_returns SET status='completed',cash_recorded=1,updated_at=? WHERE id=?").run(now(), ret.id); return this.db.prepare('SELECT * FROM customer_returns WHERE id=?').get(ret.id); });
    } catch (error) {
      // The refund is already on the Woo order; never undo it. Flag the cash for the owner.
      return this.tx(() => {
        this.db.prepare("UPDATE customer_returns SET status='cash_review',error=?,updated_at=? WHERE id=?").run(`Cash out not recorded: ${String(error.message).slice(0, 150)} Record it on an open shift.`, now(), ret.id);
        audit(this.db, user.id, 'return.cash_unrecorded', ret.id);
        return this.db.prepare('SELECT * FROM customer_returns WHERE id=?').get(ret.id);
      });
    }
  }
  async applyStock(user, ret) {
    const failures = [];
    for (const item of this.db.prepare("SELECT * FROM customer_return_items WHERE return_id=? AND stock_status='pending'").all(ret.id)) {
      if (item.disposition !== 'restock') {
        // Not sellable: kept off the website. Damaged/check-first lines wait for a decision.
        const resolved = ['write_off', 'supplier_return'].includes(item.disposition);
        this.db.prepare("UPDATE customer_return_items SET stock_status='held', resolution=?, resolved_by_name=?, resolved_at=? WHERE id=?")
          .run(resolved ? item.disposition : null, resolved ? user.name : null, resolved ? now() : null, item.id);
        continue;
      }
      const result = await this.restock(user, item, `${ret.number} · customer return`);
      if (result.error) failures.push({ itemId: item.id, name: item.name, label: item.label, error: result.error });
    }
    return failures;
  }
  async restock(user, item, note) {
    try {
      const r = await this.inventory.adjust(user, { key: `${item.id}:restock`, productId: item.product_id, variationId: item.variation_id, type: 'receive', quantity: item.quantity,
        reason: 'customer_return', note: note.slice(0, 200), enableTracking: false });
      this.db.prepare("UPDATE customer_return_items SET stock_status='restocked',stock_before=?,stock_after=? WHERE id=?").run(r.movement.before, r.movement.after, item.id);
      return r;
    } catch (error) { return { error: error instanceof AppError ? error.message : 'Unexpected error' }; }
  }

  // ---------- awaiting decision ----------
  resolve(user, itemId, input) {
    this.requireWrites();
    return this.exclusive(async () => {
      const item = this.db.prepare('SELECT i.*, r.number, r.status AS return_status FROM customer_return_items i JOIN customer_returns r ON r.id=i.return_id WHERE i.id=?').get(itemId);
      if (!item) throw new AppError('Return line not found.', 404);
      if (item.resolution) throw new AppError('This item has already been dealt with.', 409, 'ALREADY_RESOLVED');
      if (item.stock_status !== 'held') throw new AppError('This return is not finished yet. Open it and complete it first.', 409);
      if (input.action === 'restock') {
        const r = await this.restock(user, item, `${item.number} · back on sale after check${input.note ? ` · ${input.note}` : ''}`);
        if (r.error) throw new AppError(r.error, 409);
      }
      this.db.prepare('UPDATE customer_return_items SET resolution=?,resolved_by_name=?,resolved_at=?,resolution_note=? WHERE id=?').run(input.action, user.name, now(), input.note, itemId);
      audit(this.db, user.id, `return.item_${input.action}`, itemId);
      return { item: this.itemView(this.db.prepare('SELECT * FROM customer_return_items WHERE id=?').get(itemId)) };
    });
  }

  // ---------- views ----------
  itemView(i) {
    return { id: i.id, productId: i.product_id, variationId: i.variation_id, name: i.name, label: i.label, sku: i.sku, quantity: i.quantity, unitRefund: i.unit_refund,
      disposition: i.disposition, dispositionLabel: DISPOSITION_LABELS[i.disposition], stockStatus: i.stock_status, stockBefore: i.stock_before, stockAfter: i.stock_after,
      resolution: i.resolution, resolutionLabel: i.resolution ? DISPOSITION_LABELS[i.resolution] : '', resolvedByName: i.resolved_by_name || '', resolvedAt: i.resolved_at, resolutionNote: i.resolution_note };
  }
  view(r) {
    const sale = this.db.prepare('SELECT number FROM sales WHERE id=?').get(r.sale_id);
    return { id: r.id, number: r.number, saleId: r.sale_id, saleNumber: sale?.number || '', status: r.status, refundTotal: r.refund_total, paymentMethod: r.payment_method,
      cashRecorded: Boolean(r.cash_recorded), wooRefundId: r.woo_refund_id, reason: r.reason, reasonLabel: REASON_LABELS[r.reason], note: r.note,
      createdByName: r.created_by_name, createdAt: r.created_at, error: r.error,
      items: this.db.prepare('SELECT * FROM customer_return_items WHERE return_id=? ORDER BY name,label').all(r.id).map(i => this.itemView(i)) };
  }
  list({ saleId = null, limit = 100 } = {}) {
    const rows = saleId ? this.db.prepare('SELECT * FROM customer_returns WHERE sale_id=? ORDER BY created_at DESC').all(saleId)
      : this.db.prepare('SELECT * FROM customer_returns ORDER BY created_at DESC LIMIT ?').all(limit);
    return rows.map(r => this.view(r));
  }
  awaiting() {
    return this.db.prepare(`SELECT i.*, r.number, r.created_at AS returned_at, s.number AS sale_number FROM customer_return_items i JOIN customer_returns r ON r.id=i.return_id
      JOIN sales s ON s.id=r.sale_id WHERE i.stock_status='held' AND i.resolution IS NULL ORDER BY r.created_at`).all()
      .map(i => ({ ...this.itemView(i), returnNumber: i.number, saleNumber: i.sale_number, returnedAt: i.returned_at }));
  }
  summary() {
    const since = new Date(Date.now() - 30 * 86400000).toISOString();
    const r = this.db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(refund_total),0) AS total FROM customer_returns WHERE status IN ('completed','cash_review') AND created_at>=?").get(since);
    return { last30: r.n, refunded30: r.total, awaiting: this.awaiting().length,
      needsReview: this.db.prepare("SELECT COUNT(*) AS n FROM customer_returns WHERE status IN ('refunding','cash_review') OR (status='completed' AND EXISTS (SELECT 1 FROM customer_return_items WHERE return_id=customer_returns.id AND stock_status='pending'))").get().n };
  }
}
