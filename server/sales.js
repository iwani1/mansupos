import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError, now } from './errors.js';
import { audit, saleView } from './db.js';
import { validateAvailability } from './catalog.js';
import { ShiftService } from './shifts.js';

export const prepareSchema = z.object({
  idempotencyKey: z.string().uuid(),
  items: z.array(z.object({ productId: z.number().int().positive(), variationId: z.number().int().min(0).optional().default(0), quantity: z.number().int().min(1).max(999) }).strict()).min(1).max(100),
  note: z.string().trim().max(250).optional().default(''),
}).strict();
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
    const current = merged.get(key) || { productId: item.productId, variationId: item.variationId || 0, quantity: 0 };
    current.quantity += item.quantity;
    if (current.quantity > 999) throw new AppError('A single cart line cannot exceed 999 units.', 400);
    merged.set(key, current);
  }
  return [...merged.values()].sort((a, b) => a.productId - b.productId || a.variationId - b.variationId);
}
const fingerprint = (items, note = '') => createHash('sha256').update(JSON.stringify({ items: normalizeItems(items), note: String(note || '').trim() })).digest('hex');
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
    const items = (order.line_items || []).map(item => {
      const original = JSON.parse(row.items_json || '[]').find(i => i.productId === item.product_id && i.variationId === (item.variation_id || 0));
      return { productId: item.product_id, variationId: item.variation_id || 0, name: item.name, label: item.meta_data?.find(m => ['Size', 'size'].includes(m.key))?.value || original?.label || '', sku: item.sku || '', image: original?.image || '', price: money(item.price), quantity: item.quantity, total: money(item.total), tax: money(item.total_tax) };
    });
    this.db.prepare('UPDATE sales SET woo_order_id=?,number=?,status=?,total=?,tax=?,subtotal=?,refunded=?,currency=?,items_json=?,updated_at=?,paid_at=?,error=? WHERE id=?')
      .run(order.id, `${this.config.mode === 'live' ? 'WC' : 'STG'}-${order.number || order.id}`, status, total, money(order.total_tax), (order.line_items || []).reduce((sum, i) => sum + money(i.subtotal), 0), refunded, currency, JSON.stringify(items), now(), paid ? remotePaidAt(order) : null, error, row.id);
    if (isSettled(status)) this.catalog.invalidate();
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
    if (this.config.mode !== 'demo' && !this.config.writesEnabled) throw new AppError('Checkout is locked. Complete staging tests and enable the approved server-side write gate first.', 403, 'CHECKOUT_LOCKED');
    const items = normalizeItems(input.items);
    const hash = fingerprint(items, input.note);
    return this.exclusive(`prepare:${input.idempotencyKey}`, async () => {
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
      const shift = this.config.requireShift && this.config.mode !== 'demo' ? this.shifts.requireOpen(user.id) : this.shifts.current(user.id);
      const id = randomUUID();
      const time = now();
      const number = `DEMO-${id.slice(0, 8).toUpperCase()}`;
      this.db.prepare('INSERT INTO sales(id,idempotency_key,fingerprint,number,status,currency,cashier_id,cashier_name,note,created_at,updated_at,shift_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, input.idempotencyKey, hash, number, 'creating', this.config.currency, user.id, user.name, input.note, time, time, shift?.id || null);
      try {
        const lines = await this.catalog.fresh(items);
        validateAvailability(lines);
        if (this.config.mode === 'demo') {
          const total = lines.reduce((sum, line) => sum + line.price * line.quantity, 0);
          this.db.prepare('UPDATE sales SET status=?,total=?,prepared_total=?,subtotal=?,items_json=? WHERE id=?').run('awaiting_payment', total, total, total, JSON.stringify(lines.map(l => ({ ...l, total: l.price * l.quantity, tax: 0 }))), id);
        } else {
          const order = await this.api.createOrder({
            status: 'pending', payment_method: '', payment_method_title: 'In-store payment pending',
            line_items: items.map(i => ({ product_id: i.productId, ...(i.variationId ? { variation_id: i.variationId } : {}), quantity: i.quantity })),
            shipping: [], customer_note: input.note,
            meta_data: [{ key: '_mansu_pos_key', value: input.idempotencyKey }, { key: '_mansu_pos_channel', value: 'mansu-pos' }, { key: '_mansu_pos_cashier', value: user.id }],
          });
          this.db.prepare('UPDATE sales SET woo_order_id=? WHERE id=?').run(order.id, id);
          const saved = this.saveRemote(this.get(id, user), order);
          this.db.prepare('UPDATE sales SET prepared_total=? WHERE id=?').run(saved.total, id);
          if (saved.status !== 'awaiting_payment') throw new AppError(saved.error || 'WooCommerce did not return a payable pending order. Review Sales before retrying.', 409, 'RECONCILIATION_REQUIRED');
        }
        audit(this.db, user.id, 'sale.prepared', id);
        return saleView(this.get(id, user));
      } catch (error) {
        const mayExistRemotely = Boolean(this.get(id, user).woo_order_id);
        this.db.prepare('UPDATE sales SET status=?,error=?,updated_at=? WHERE id=?').run(error.uncertain || mayExistRemotely ? 'needs_reconciliation' : 'failed', error.message, now(), id);
        if (error instanceof AppError && !error.uncertain && !mayExistRemotely) throw error;
        throw new AppError('Checkout was interrupted. Do not create another order; reconcile this sale from Sales first.', 502, 'RECONCILIATION_REQUIRED');
      }
    });
  }
  async complete(user, id, payment) {
    return this.exclusive(`sale:${id}`, async () => {
      const row = this.get(id, user);
      if (isSettled(row.status)) return saleView(row);
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
        if (error instanceof AppError && ['TOTAL_CHANGED', 'ORDER_CANCELLED'].includes(error.code)) throw error;
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
